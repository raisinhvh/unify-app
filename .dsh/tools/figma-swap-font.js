// Swap the UI font across a Figma page, leaving code fonts alone.
// Run with figma_execute: paste this file as `code` after editing the CONFIG block.
// Updates local text styles whose name starts with STYLE_PREFIX, then every unstyled text
// segment on PAGE. Families in KEEP (e.g. the code font) are never touched.
// Each weight maps to the nearest style the new family has (Medium -> Regular if 500 is missing).

const CONFIG = {
	FAMILY: 'Anonymous Pro',
	PAGE: 'Unify',
	STYLE_PREFIX: 'unify/',
	KEEP: ['JetBrains Mono'],
};

const WEIGHTS = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
const weightOf = (style) => {
	const key = style.toLowerCase().replace(/italic/, '').replace(/[\s-]/g, '') || 'regular';
	return WEIGHTS[key] ?? 400;
};
const isItalic = (style) => /italic/i.test(style);

const available = (await figma.listAvailableFontsAsync())
	.filter((font) => font.fontName.family === CONFIG.FAMILY)
	.map((font) => font.fontName.style);
if (available.length === 0) return `Font "${CONFIG.FAMILY}" is not available in Figma.`;

// A text style can pin its intended weight with "weight: 800" in its description, so swapping
// through a font with few weights (400/700 only) doesn't lose Extra Bold / Black titles.
const nearestStyle = (fromStyle, intendedWeight) => {
	const wantItalic = isItalic(fromStyle);
	const pool = available.filter((style) => isItalic(style) === wantItalic);
	const candidates = pool.length > 0 ? pool : available;
	const target = intendedWeight ?? weightOf(fromStyle);
	return candidates.reduce((best, style) => (Math.abs(weightOf(style) - target) < Math.abs(weightOf(best) - target) ? style : best));
};

for (const style of available) await figma.loadFontAsync({ family: CONFIG.FAMILY, style });
const skip = new Set([CONFIG.FAMILY, ...CONFIG.KEEP]);

let stylesChanged = 0;
for (const textStyle of await figma.getLocalTextStylesAsync()) {
	if (!textStyle.name.startsWith(CONFIG.STYLE_PREFIX) || skip.has(textStyle.fontName.family)) continue;
	await figma.loadFontAsync(textStyle.fontName);
	const pinned = textStyle.description.match(/weight:\s*(\d{3})/);
	textStyle.fontName = { family: CONFIG.FAMILY, style: nearestStyle(textStyle.fontName.style, pinned ? Number(pinned[1]) : undefined) };
	stylesChanged++;
}

const page = figma.root.children.find((child) => child.name === CONFIG.PAGE);
if (!page) return `Page "${CONFIG.PAGE}" not found.`;
await page.loadAsync();

let segmentsChanged = 0;
let failed = 0;
for (const textNode of page.findAllWithCriteria({ types: ['TEXT'] })) {
	for (const segment of textNode.getStyledTextSegments(['fontName', 'textStyleId'])) {
		if (segment.textStyleId || skip.has(segment.fontName.family)) continue;
		try {
			await figma.loadFontAsync(segment.fontName);
			textNode.setRangeFontName(segment.start, segment.end, { family: CONFIG.FAMILY, style: nearestStyle(segment.fontName.style) });
			segmentsChanged++;
		} catch {
			failed++;
		}
	}
}

return { family: CONFIG.FAMILY, stylesChanged, segmentsChanged, failed };
