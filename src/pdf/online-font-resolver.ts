import * as mupdf from 'mupdf';

export interface OnlineFontMatch {
  bytes: Uint8Array;
  family: string;
  source: string;
}

interface OnlineFontCandidate {
  family: string;
  matches: (normalizedName: string) => boolean;
  regularUrl: string;
  italicUrl: string;
  boldUrl?: string;
  boldItalicUrl?: string;
}

const GOOGLE_FONTS_COMMIT = 'ae50998cbcab558ae1f047ad5c724ec7261980ca';
const GOOGLE_FONTS_RAW = `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}`;

const candidates: OnlineFontCandidate[] = [
  {
    // Carlito is the metrically compatible, OFL-licensed Calibri substitute
    // available to the browser build when a Calibri subset lacks a new glyph.
    family: 'Carlito',
    matches: (name) => name.includes('CALIBRI'),
    regularUrl: `${GOOGLE_FONTS_RAW}/ofl/carlito/Carlito-Regular.ttf`,
    italicUrl: `${GOOGLE_FONTS_RAW}/ofl/carlito/Carlito-Italic.ttf`,
    boldUrl: `${GOOGLE_FONTS_RAW}/ofl/carlito/Carlito-Bold.ttf`,
    boldItalicUrl: `${GOOGLE_FONTS_RAW}/ofl/carlito/Carlito-BoldItalic.ttf`,
  },
  {
    family: 'Roboto Condensed',
    matches: (name) => name.includes('ARIALNARROW'),
    regularUrl: `${GOOGLE_FONTS_RAW}/ofl/robotocondensed/RobotoCondensed%5Bwght%5D.ttf`,
    italicUrl: `${GOOGLE_FONTS_RAW}/ofl/robotocondensed/RobotoCondensed-Italic%5Bwght%5D.ttf`,
  },
];

const downloaded = new Map<string, Promise<Uint8Array>>();

function normalizeFontName(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase();
}

function hasAllGlyphs(font: mupdf.Font, text: string): boolean {
  return [...text].every((character) =>
    /\s/.test(character) || font.encodeCharacter(character.codePointAt(0) ?? 0) !== 0);
}

async function download(url: string): Promise<Uint8Array> {
  let pending = downloaded.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Font download returned HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    });
    downloaded.set(url, pending);
  }
  try {
    return await pending;
  } catch (value) {
    downloaded.delete(url);
    throw value;
  }
}

export async function resolveOnlineFont(fontName: string, replacementText: string): Promise<OnlineFontMatch | null> {
  const normalizedName = normalizeFontName(fontName);
  const candidate = candidates.find((value) => value.matches(normalizedName));
  if (!candidate) return null;

  const italic = normalizedName.includes('ITALIC') || normalizedName.includes('OBLIQUE');
  const bold = normalizedName.includes('BOLD') || normalizedName.includes('SEMIBOLD');
  const url = bold && italic
    ? candidate.boldItalicUrl ?? candidate.boldUrl ?? candidate.italicUrl
    : bold
      ? candidate.boldUrl ?? candidate.regularUrl
      : italic
        ? candidate.italicUrl
        : candidate.regularUrl;
  const bytes = await download(url);
  const font = new mupdf.Font(candidate.family, bytes);
  try {
    return hasAllGlyphs(font, replacementText)
      ? { bytes, family: candidate.family, source: url }
      : null;
  } finally {
    font.destroy();
  }
}
