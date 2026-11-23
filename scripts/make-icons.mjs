/**
 * Renders the app icons in build/ (icon.png, icon.ico, icon.icns) from the Unify logo mark
 * (the same paths as LogoMark in src/renderer/backdrop/Backdrop.tsx) on a dark rounded tile.
 * Run after the logo or its wood colours change: node scripts/make-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const buildDir = join(process.cwd(), 'build');
const woodLight = '#C9A465';
const woodDark = '#8B6A35';
const tileColor = '#161310';
const tileEdge = '#2A241D';

// The mark's 32x32 artwork spans x 4..28 and y 2..30; centre it in a 1024 tile at ~62% height.
const markScale = 22;
const markOffsetX = 512 - 16 * markScale;
const markOffsetY = 512 - 16 * markScale;

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
	<rect x="16" y="16" width="992" height="992" rx="224" fill="${tileColor}" stroke="${tileEdge}" stroke-width="8"/>
	<g transform="translate(${markOffsetX} ${markOffsetY}) scale(${markScale})">
		<path d="M4 2H12.4V19.2H15.5V27.6H4V2Z" fill="${woodLight}"/>
		<path d="M16.5 21.6H19.6V4.4H28V30H16.5V21.6Z" fill="${woodDark}"/>
	</g>
</svg>`;

async function renderPng(size) {
	return sharp(Buffer.from(iconSvg))
		.resize(size, size)
		.png()
		.toBuffer();
}

/** ICO with PNG-compressed entries (supported since Windows Vista). */
function buildIco(entries) {
	const headerSize = 6 + entries.length * 16;
	const header = Buffer.alloc(headerSize);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(entries.length, 4);
	let dataOffset = headerSize;
	entries.forEach((entry, index) => {
		const base = 6 + index * 16;
		header.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
		header.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
		header.writeUInt8(0, base + 2);
		header.writeUInt8(0, base + 3);
		header.writeUInt16LE(1, base + 4);
		header.writeUInt16LE(32, base + 6);
		header.writeUInt32LE(entry.data.length, base + 8);
		header.writeUInt32LE(dataOffset, base + 12);
		dataOffset += entry.data.length;
	});
	return Buffer.concat([header, ...entries.map(entry => entry.data)]);
}

/** ICNS with PNG entries for the retina-era types. */
function buildIcns(entries) {
	const chunks = entries.map(entry => {
		const chunkHeader = Buffer.alloc(8);
		chunkHeader.write(entry.type, 0, 'ascii');
		chunkHeader.writeUInt32BE(entry.data.length + 8, 4);
		return Buffer.concat([chunkHeader, entry.data]);
	});
	const body = Buffer.concat(chunks);
	const fileHeader = Buffer.alloc(8);
	fileHeader.write('icns', 0, 'ascii');
	fileHeader.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([fileHeader, body]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoEntries = [];
for (const size of icoSizes) {
	icoEntries.push({
		size,
		data: await renderPng(size),
	});
}

const icnsTypes = [
	{ type: 'icp4', size: 16 },
	{ type: 'icp5', size: 32 },
	{ type: 'icp6', size: 64 },
	{ type: 'ic07', size: 128 },
	{ type: 'ic08', size: 256 },
	{ type: 'ic09', size: 512 },
	{ type: 'ic10', size: 1024 },
];
const icnsEntries = [];
for (const entry of icnsTypes) {
	icnsEntries.push({
		type: entry.type,
		data: await renderPng(entry.size),
	});
}

writeFileSync(join(buildDir, 'icon.png'), await renderPng(512));
writeFileSync(join(buildDir, 'icon.ico'), buildIco(icoEntries));
writeFileSync(join(buildDir, 'icon.icns'), buildIcns(icnsEntries));
console.log('Wrote build/icon.png, build/icon.ico, build/icon.icns');
