export interface Chunk {
    heading: string | null;
    text: string;
}

export interface ChunkOptions {
    /** Target max characters per chunk (~4 chars/token). */
    maxChars: number;
    /** Characters of overlap carried into the next chunk of the same section. */
    overlapChars: number;
}

const DEFAULTS: ChunkOptions = { maxChars: 2000, overlapChars: 300 };

/**
 * Splits markdown/plain text into chunks that never cross a heading, so each
 * chunk keeps a meaningful "section" label for citation in the prompt.
 */
export function chunkText(
    raw: string,
    opts: Partial<ChunkOptions> = {},
): Chunk[] {
    const { maxChars, overlapChars } = { ...DEFAULTS, ...opts };
    const sections: { heading: string | null; body: string[] }[] = [
        { heading: null, body: [] },
    ];
    const trail: string[] = [];

    for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (m) {
            const level = m[1]!.length;
            trail.length = level - 1;
            trail[level - 1] = m[2]!.trim();
            sections.push({
                heading: trail.filter(Boolean).join(' › '),
                body: [],
            });
        } else {
            sections.at(-1)!.body.push(line);
        }
    }

    const chunks: Chunk[] = [];
    for (const { heading, body } of sections) {
        const text = body.join('\n').trim();
        if (!text) continue;
        for (const piece of splitLong(text, maxChars, overlapChars)) {
            chunks.push({ heading, text: piece });
        }
    }
    return chunks;
}

function splitLong(text: string, max: number, overlap: number): string[] {
    if (text.length <= max) return [text];
    const paras = text.split(/\n{2,}/);
    const out: string[] = [];
    let cur = '';
    for (const p of paras.flatMap((x) =>
        x.length > max ? hardSplit(x, max) : [x],
    )) {
        if (cur && cur.length + p.length + 2 > max) {
            out.push(cur);
            cur = cur.slice(-overlap);
            cur = cur.slice(cur.indexOf(' ') + 1);
        }
        cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur) out.push(cur);
    return out;
}

function hardSplit(text: string, max: number): string[] {
    const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
    const out: string[] = [];
    let cur = '';
    for (const s of sentences) {
        if (cur && cur.length + s.length > max) {
            out.push(cur.trim());
            cur = '';
        }
        cur += s;
        while (cur.length > max) {
            out.push(cur.slice(0, max));
            cur = cur.slice(max);
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}
