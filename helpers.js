export function zpad(data, length) {
	return ('0'.repeat(length) + data).substr(0 - length)
}

export function str2hex(str) {
	var result = ''

	for (var i = 0; i < str.length; ++i) {
		result += zpad(str.charCodeAt(i).toString(16), 2)
	}

	return result
}
