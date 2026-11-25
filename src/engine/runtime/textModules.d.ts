/** Shell scripts are bundled as text (esbuild loader `.sh: 'text'` in scripts/build.mjs and the build:test script). */
declare module '*.sh' {
	const text: string;
	export default text;
}
