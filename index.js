import { InstanceBase, Regex, TCPHelper, combineRgb, runEntrypoint } from '@companion-module/base'

import UpgradeScripts from './upgrades.js'

import { zpad, str2hex } from './helpers.js'

/**
 * AMP Protocol documentation:
 * http://www.gvgdevelopers.com/concrete/apis/amp_protocol/
 * http://www.gvgdevelopers.com/Protocols/AMP_SDK/Docs/AMP%20at%20a%20glance.pdf
 * http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/11/ (K2_Protocol_Developers_Guide.pdf)
 * http://www.gvgdevelopers.com/concrete/index.php/download_file/-/view/10 (AMP Specification)
 */

class GrassvalleyAmp extends InstanceBase {
	async configUpdated(config) {
		let reconnect = this.config.host !== config.host || this.config.channel !== config.channel;

		this.config = config;
		if (reconnect) {
			this.init_tcp();
		}
	}

	async init(config) {
		this.config = config;

		this.awaiting_reply = false;
		this.command_queue = [];
		this.files = [];
		this.last_bit_check = null;
		this.current_transport_status = 'UNKNOWN';

		// Number of ms to grab transport updates
		this.TRANSPORT_UPDATES = 2000;

		this.transport_bits = {
			PLAY: {
				id: '0',
				label: 'Playing',
			},
			RECORD: {
				id: '1',
				label: 'Recording',
			},
			FF: {
				id: '2',
				label: 'FF',
			},
			RW: {
				id: '3',
				label: 'RW',
			},
			STOP: {
				id: '5', // Warning: this seems to always be 0 although documentation says it will be set
				label: 'Stopped'
			},
			UNKNOWN: {
				id: '-1',
				label: 'Unknown'
			}
		};

		this.actions(); // export actions
		
		this.init_tcp();
		this.initFeedbacks();
		this.initVariables();
	}

	init_tcp() {
		if (this.socket !== undefined) {
			this.destroy();
		}

		if (this.transport_timer) {
			clearTimeout(this.transport_timer);
		}

		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, 3811);

			this.socket.on('connect', () => {
				this.initAMPSocket();
				this.updateStatus('ok')
			});

			this.socket.on('error', (err) => {
				this.log('error',"Network error: " + err.message);
			});

			this.socket.on('end', () => {
				if (this.transport_timer) {
					clearTimeout(this.transport_timer);
				}
			});

			this.socket.on('data', (chunk) => {
				this.buffer = chunk;

				if (this.waiting_for_crat && this.buffer.length >= 4) {
					var result = this.buffer.slice(0, 4).toString();
					this.buffer = this.buffer.slice(4);

					this.waiting_for_crat = false;

					if (result.match(/1111/)) {
						this.log('error', 'Error opening AMP socket, server said NAK');
					}
					else if (result.match(/1001/)) {
						// ACKed, ok
						this.getFileList();
					} else {
						this.log('error', 'Unkown data received while connecting to device');
						this.log('debug', `Did not expect ${result}`);
					}
				} else if (this.awaiting_reply) {
					if (this.buffer.length >= 4) {
						var str = this.buffer.toString();
						var cmd1 = parseInt(str[0], 16);
						var count = parseInt(str[1], 16);
						var cmd2 = parseInt(str[2] + str[3], 16);

						switch (cmd1) {
							case 8:
								if (cmd2 == 0x14) {
									this.handleListFirstID();
								} else
								if (cmd2 == 0x8A) {
									this.handleListNextID();
								}
								break;
							case 1:
								if (count == 0 && cmd2 == 1) { // ack
									this.buffer = this.buffer.slice(4);
								} else
								if (count == 1 && cmd2 == 0x12) {
									this.buffer = this.buffer.slice(6);
									this.log('error', 'Error received on last command');
									// Todo parse NAK bits
								}
								break;
							case 7:
								if (cmd2 == 0x20 && count == 2) { // 72.20
									this.handleTransportInfo(this.buffer);
								}
						}

						// Todo: fiks
						this.awaiting_reply = false;

						if (this.command_queue.length > 0) {
							this._sendCommand(this.command_queue.shift());
						}
					}
				}
			});
		}
	}

	getFileList() {
		// @todo it'd probably be a good idea to refresh to file list every X minutes
		this.files = [];
		this.sendCommand('a2140000');
		this.sendCommand('a115ff');
	}

	handleListFirstID() {
		let buffer = this.buffer.toString();

		this.log('debug', `handleListFirstID: ${this.buffer[1]}`);
		if (buffer[1] == '0' && this.buffer.length >= 6) {
			this.log('debug', 'no clips');
			this.buffer = this.buffer.slice(6);
		} else if (buffer[1] == '8' && this.buffer.length >= 22) {
			this.log('debug', 'Clip 8 byte mode ' + Buffer.from(this.buffer.slice(4, 4 + 16).toString(), 'hex').toString());

			this.files.push(Buffer.from(this.buffer.slice(4, 4 + 16).toString(), 'hex').toString());
			this.buffer = this.buffer.slice(4 + 16 + 2);
		} else if (buffer[1] == 'A' || buffer[1] == 'a' && this.buffer.length >= 12) {
			var len = parseInt(buffer.substr(4,4), 16);
			this.log('debug', `Going to try to read ${len} bytes of clips`);
			var i = 0;

			if (buffer.length < len*2) { return; }

			while (len > 0 && 8+4+i < buffer.length) {
				var len2 = parseInt(buffer.substr(8 + i, 4), 16);
				var name = buffer.substr(8+i+4, len2 * 2);
				this.log('debug', 'Clip: ' + Buffer.from(name, 'hex').toString());
				this.files.push(Buffer.from(name, 'hex').toString());
				i += 4 + (len2 * 2);
			}

			this.buffer = this.buffer.slice(8 + (len * 2) + 2);
			this.actions();
		}
	}

	_getBit(byte, bit) {
		return (byte >> bit) % 2;
	}

	handleTransportInfo(buffer) {
		const bit_check = buffer.toString('utf8', 7, 8);

		if (bit_check !== this.last_bit_check) {
			this.last_bit_check = bit_check;
			if (this._getBit(bit_check, this.transport_bits.RECORD.id)) {
				this.current_transport_status = 'RECORD';
			} else if (this._getBit(bit_check, this.transport_bits.PLAY.id)) {
				this.current_transport_status = 'PLAY';
			} else if (this._getBit(bit_check, this.transport_bits.FF.id)) {
				this.current_transport_status = 'FF';
			} else if (this._getBit(bit_check, this.transport_bits.RW.id)) {
				this.current_transport_status = 'RW';
			} else {
				this.current_transport_status = 'STOP';
			}
			this.setVariableValues({
				transport: this.transport_bits[this.current_transport_status].label
			});

			this.checkFeedbacks('transport');
		}

		this.transport_timer = setTimeout(this.statusUpdates.bind(this), this.TRANSPORT_UPDATES);
	}

	async initAMPSocket() {
		// We don't want to keep waiting for data that'll never come...
		this.awaiting_reply = false;
		this.command_queue = [];

		const channel = this.config.channel;

		this.buffer = Buffer.from('');

		if (channel !== undefined) {
			this.waiting_for_crat = true;
			await this.socket.send('CRAT' + zpad(channel.length + 3, 4) + '2' + zpad(channel.length, 2) + channel + "\n");

			this.transport_timer = setTimeout(this.statusUpdates.bind(this), this.TRANSPORT_UPDATES);
		}
	}

	initFeedbacks() {
		const feedbacks = {
			transport: {
				type: 'boolean',
				name: 'Transport state changes',
				description: 'Changes feedback based on transport state',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(51, 102, 0)
				},
				options: [
					{
						type: 'dropdown',
						label: 'Transport state',
						id: 'transport_state',
						default: this.transport_bits[this.current_transport_status].id,
						choices: Object.values(this.transport_bits)
					}
				],
				callback: (feedback) => feedback.options.transport_state === this.transport_bits[this.current_transport_status].id
			}
		};

		this.setFeedbackDefinitions(feedbacks);

		for(let feedback in feedbacks) {
			this.checkFeedbacks(feedback);
		}
	}

	initVariables() {
		const variables = [
			{
				name: 'Transport status',
				variableId:  'transport'
			}
		];

		this.setVariableDefinitions(variables);
		this.setVariableValues({
			transport: this.transport_bits[this.current_transport_status].label
		});
	}

	sendCommand(command) {
		if (!this.awaiting_reply) {
			this._sendCommand(command);
		} else {
			this.log('debug', `queueing command ${command}`);
			this.command_queue.push(command);
		}
	}

	statusUpdates() {
		this.sendCommand('612002');
	}

	_toHexLength(length) {
		return parseInt(length).toString(16);
	}

	async _sendCommand(command) {
		if (command.length > 9999) {
			this.log('error', 'Internal error, command too long');
			return;
		}

		if (this.socket !== undefined && this.socket.isConnected) {
			this.awaiting_reply = true;
			let send_command = 'CMDS' + zpad(command.length, 4) + command;
			this.log('debug', `Sending command: ${send_command}`);
			await this.socket.send(send_command + "\n");
		} else {
			this.log('debug', 'Socket not connected :(');
		}
	}

	getConfigFields () {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: "This module connects to VTR's that support the AMP protocol"
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Device IP',
				width: 6,
				regex: Regex.IP
			},
			{
				type: 'textinput',
				id: 'channel',
				label: 'AMP Channel',
				width: 6,
				default: 'Vtr1'
			}
		]
	}

	// When module gets deleted
	async destroy() {
		if (this.socket !== undefined) {
			await this.socket.send('STOP0000\n');
			this.socket.destroy();
			delete this.socket;
		}

		if (this.transport_timer) {
			clearTimeout(this.transport_timer);
		}
	}

	actions(system) {
		let speed_list = [
			{id: '48', label: '0.32x'},
			{id: '39', label: '0.16x'},
			{id: '30', label: '0.8x'},
			{id: '20', label: '0.4x'},
			{id: '10', label: '0.2x'},
			{id: '74', label: '2x'},
			{id: '83', label: '4x'},
			{id: '93', label: '8x'},
			{id: '103', label: '16x'},
			{id: '112', label: '32x'}
		];

		this.setActionDefinitions({
			play: {
				name: 'Play',
				options: [],
				callback: this.sendCommand.bind(this, '2001')
			},
			
			set_loop: {
				name: 'Loop playback (On/Off)',
				description: 'Sets AMP loop playback mode via 41.42 with 1=On, 0=Off',
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: '01', // On by default
						choices: [
							{ id: '01', label: 'On' },
							{ id: '00', label: 'Off' },
						],
					},
				],
				callback: (event) => {
					// AMP: 41.42 then 1/0 for on/off
					this.sendCommand('4142' + event.options.state)
				},
			},
		
			stop: {
				name: 'Stop',
				options: [],
				callback: this.sendCommand.bind(this, '2000')
			},

			rw: {
				name: 'Shuttle Reverse',
				options: [
					{
						label: 'Speed',
						id: 'speed',
						default: speed_list[5].id,
						type: 'dropdown',
						choices: speed_list
					}
				],
				callback: (event) => {
					this.sendCommand('2123' + parseInt(event.options.speed).toString(16))
				}
			},

			ff: {
				name: 'Shuttle Forward',
				options: [
					{
						label: 'Speed',
						id: 'speed',
						default: speed_list[5].id,
						type: 'dropdown',
						choices: speed_list
					}
				],
				callback: (event) => {
					this.sendCommand('2113' + parseInt(event.options.speed).toString(16));
				}
			},

			eject: {
				name: 'Eject',
				options: [],
				callback: this.sendCommand.bind(this, '200f')
			},

			record: {
				name: 'Record',
				options: [],
				callback: this.sendCommand.bind(this, '2002')
			},

			loadclip: {
				name: 'Load clip',
				description: 'Custom names with variables are allowed.',
				options: [
					{
						label: 'Clip name',
						id: 'clip',
						type: 'dropdown',
						default: '',
						useVariables: true,
						allowCustom: true,
						regex: '/^\\S.*$/',
						choices: [].concat(
							[ { id: '', label: ' - None - ' } ],
							this.files.map((el) => {
								return {
									id: el,
									label: el
								}
							})
						)
					}
				],
				callback: async (event) => {
					const clip_name = await this.parseVariablesInString(event.options.clipdd || event.options.clip);

					this.sendCommand(this._buildCommand('4A14', [
						[clip_name, false, 4]
					]));
				}
			},

			recordclip: {
				name: 'Record clip',
				options: [
					{
						label: 'Clip name',
						id: 'clip',
						type: 'textinput',
						regex: '/^\\S.*$/',
						useVariables: true
					}
				],
				callback: async (event) => {
					const clip_name = await this.parseVariablesInString(event.options.clip);

					this.sendCommand(this._buildCommand('AE02', [
						['00000000', 8], // TC
						[clip_name, false, 4]
					]));
				}
			}
		});
	}

	/**
	 * Builds a command that can be sent to the device
	 * Automatically calculates the actual byte count
	 * @returns String
	 */
	_buildCommand(name, list) {
		// Bytes to hex
		// Length (false if no length, see next)
		// Add length before sending?
		let command = '',
			actual_byte_cnt = 0;

		list.forEach(function(cmd_str) {
			if(cmd_str[1] === false) {
				actual_byte_cnt += cmd_str[0].length + (cmd_str[2] / 2);
				command += zpad(cmd_str[0].length.toString(16), cmd_str[2]);
				command += str2hex(cmd_str[0]);
			} else {
				actual_byte_cnt += cmd_str[1] / 2;
				command += zpad(str2hex(cmd_str[0]), cmd_str[1]);
			}
		});

		return name + zpad(actual_byte_cnt.toString(16), 4) + command;
	}
}

runEntrypoint(GrassvalleyAmp, UpgradeScripts)
