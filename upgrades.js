import { CreateConvertToBooleanFeedbackUpgradeScript } from '@companion-module/base'

export default [
	CreateConvertToBooleanFeedbackUpgradeScript({
		transport: {
			bg: 'bgcolor',
			fg: 'color',
			text: 'text',
		},
	}),

	function (context, props) {
		const new_actions = []

		props.actions.forEach((x) => {
			if (x.options && 'clipdd' in x.options) {
				if ('clip' in x.options && x.options.clip == '') {
					x.options.clip = x.options.clipdd
				}

				delete x.options.clipdd
			}

			new_actions.push(x)
		})

		return {
			updatedConfig: null,
			updatedActions: new_actions,
			updatedFeedbacks: [],
		}
	},
]
