/**
 * Tells Dutch from English by counting common function words. Only these two
 * languages are supported (SOP rule R4). Returns null when the text is too
 * short or too mixed to tell, so callers never act on a guess.
 */
export type Language = 'nl' | 'en';

const NL = new Set(
    'de het een en ik je jij u wij we zij is zijn was ben bent heb hebt heeft niet geen wat wie waar wanneer hoe hoeveel kan kun kunt wil wilt graag ook nog maar dus of als met voor van op aan bij naar om te er dat dit die deze mijn jouw jullie onze hoi hallo dank bedankt alvast morgen vandaag goed ja nee welke waarom moet mag zou even'.split(
        ' ',
    ),
);
const EN = new Set(
    'the a an and i you he she we they is are am was were be have has had not no what who where when how much many can could would will want please also but so or if with for of on at to from this that these those my your our hi hello thanks thank tomorrow today good yes do does did which why must may should just'.split(
        ' ',
    ),
);

export function detectLanguage(text: string): Language | null {
    const words = text
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/[^\p{L}']+/u)
        .filter(Boolean);
    let nl = 0;
    let en = 0;
    for (const w of words) {
        if (NL.has(w)) nl++;
        if (EN.has(w)) en++;
    }
    // Need a clear signal: a few hits and one language clearly ahead.
    if (nl + en < 2) return null;
    if (nl >= 2 && nl >= en * 2) return 'nl';
    if (en >= 2 && en >= nl * 2) return 'en';
    return null;
}

export const LANGUAGE_NAMES: Record<Language, string> = {
    nl: 'Dutch',
    en: 'English',
};
