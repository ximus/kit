/** @type {import('./$types').PageLoad} */
export async function load({ fetch, data, url }) {
	const { a } = data;

	const resquest = () => fetch(new URL('/load/serialization/fetched-from-shared.json', url.origin));
	const { b: json } = await resquest().then((r) => r.json());
	const { b: text } = await resquest()
		.then((r) => r.text())
		.then(JSON.parse);
	const { b: arrayBuffer } = await resquest()
		.then((r) => r.arrayBuffer())
		.then((buffer) => JSON.parse(new TextDecoder().decode(buffer)));
	const { b: stream } = await resquest()
		.then((r) => r.body.getReader().read())
		.then(({ value }) => JSON.parse(new TextDecoder().decode(value.buffer)));

	const b = json + text + arrayBuffer + stream;
	return { a, b, c: a + b };
}
