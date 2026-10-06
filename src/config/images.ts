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
        /**
         * Send as WhatsApp "view once": it opens a single time, can't be
         * forwarded or saved, and WhatsApp blocks screenshots on most phones.
         */
        view_once: z.boolean().default(false),
        /**
         * When a customer message contains one of these, this image is sent
         * by code, whatever the model decides (e.g. "foto", "picture").
         */
        request_keywords: z.array(z.string().min(1)).default([]),
        /** Overrides IMAGE_RESEND_HOURS for this image (0 = send every time). */
        resend_after_hours: z.number().min(0).max(720).optional(),
        /** Sent first, before the text, in the first reply to every new customer. */
        first_contact: z.boolean().default(false),
    })
    .strict();

const Manifest = z.array(ImageEntry).default([]);

export interface PreloadedImage {
    id: string;
    caption: string;
    whenToUse: string;
    viewOnce: boolean;
    requestKeywords: string[];
    /** null = use the global IMAGE_RESEND_HOURS setting. */
    resendAfterHours: number | null;
    /** Sent first in the first reply to every new customer. */
    firstContact: boolean;
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

    const welcome = parsed.data.filter((e) => e.first_contact);
    if (welcome.length > 1) {
        throw new Error(
            `${manifestFile}: only one image can have first_contact: true (found ${welcome.map((e) => e.id).join(', ')})`,
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
            viewOnce: entry.view_once,
            requestKeywords: entry.request_keywords,
            resendAfterHours: entry.resend_after_hours ?? null,
            firstContact: entry.first_contact,
            mimetype,
            data: fs.readFileSync(file),
        });
    }
    return lib;
}
