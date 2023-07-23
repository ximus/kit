/** @type {import('./$types').PageServerLoad} */
export async function load({ fetch }) {
	const resquest = () => fetch('/load/serialization/fetched-from-server.json');
	const { a: json } = await resquest().then((r) => r.json());
	const { a: text } = await resquest()
		.then((r) => r.text())
		.then(JSON.parse);
	const { a: arrayBuffer } = await resquest()
		.then((r) => r.arrayBuffer())
		.then((buffer) => JSON.parse(new TextDecoder().decode(buffer)));
	const { a: stream } = await resquest()
		.then((r) => r.body.getReader().read())
		.then(({ value }) => JSON.parse(new TextDecoder().decode(value.buffer)));
	const a = json + text + arrayBuffer + stream;
	return { a };
}
