import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const ImageEntry = z
    .object({
        id: z.string().regex(/^[a-z0-9_]+$/),
        file: z.string().min(1),
        caption: z.string().default(''),
        when_to_use: z.string().min(1),
    })
    .strict();

const Manifest = z.array(ImageEntry).default([]);

export interface PreloadedImage {
    id: string;
    caption: string;
    whenToUse: string;
    mimetype: string;
    data: Buffer;
}

export type ImageLibrary = Map<string, PreloadedImage>;

const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

/**
 * Loads config/images.yaml and reads every referenced file into memory.
 * A missing file or bad entry is a startup error, never a runtime surprise.
 */
export function loadImages(
    manifestFile: string,
    assetsDir: string,
): ImageLibrary {
    const lib: ImageLibrary = new Map();
    if (!fs.existsSync(manifestFile)) return lib;

    const parsed = Manifest.safeParse(
        YAML.parse(fs.readFileSync(manifestFile, 'utf8')) ?? [],
    );
    if (!parsed.success) {
        throw new Error(
            `${manifestFile} is invalid:\n${z.prettifyError(parsed.error)}`,
        );
    }

    for (const entry of parsed.data) {
        if (lib.has(entry.id)) {
            throw new Error(
                `${manifestFile}: duplicate image id "${entry.id}"`,
            );
        }
        const file = path.resolve(assetsDir, entry.file);
        const mimetype = MIME[path.extname(file).toLowerCase()];
        if (!mimetype) {
            throw new Error(
                `${manifestFile}: "${entry.file}" must be .jpg, .jpeg, .png or .webp`,
            );
        }
        if (!fs.existsSync(file)) {
            throw new Error(
                `${manifestFile}: image "${entry.id}" points to missing file ${file}`,
            );
        }
        lib.set(entry.id, {
            id: entry.id,
            caption: entry.caption,
            whenToUse: entry.when_to_use,
            mimetype,
            data: fs.readFileSync(file),
        });
    }
    return lib;
}
