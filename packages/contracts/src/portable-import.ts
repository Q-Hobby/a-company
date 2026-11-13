import * as z from "zod";

export const PORTABLE_IMPORT_MAX_PACKET_CHARS = 12 * 1024 * 1024;
export const PORTABLE_IMPORT_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
export const PORTABLE_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const LocalImportSourceSchema = z.enum(["hermes", "codex"]);
export type LocalImportSource = z.infer<typeof LocalImportSourceSchema>;

/** Relative portable paths only, never a host path or executable filesystem link. */
export function isSafeImportPath(value: string): boolean {
  if (
    !value ||
    value.length > 500 ||
    /[\\:<>"|?*]/.test(value) ||
    value.startsWith("/") ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(
          part.normalize("NFKC"),
        ),
    );
}

export const ImportFileSchema = z.object({
  path: z.string().refine(isSafeImportPath, "Unsafe import path"),
  contentBase64: z.string().max(Math.ceil(PORTABLE_IMPORT_MAX_FILE_BYTES / 3) * 4),
});
export type ImportFile = z.infer<typeof ImportFileSchema>;

const identity = {
  id: z.string().min(1).max(200),
  source: LocalImportSourceSchema,
};
export const ImportMessageSchema = z.object({
  id: z.string().max(200),
  role: z.string().min(1).max(80),
  content: z.string().max(2 * 1024 * 1024),
  timestamp: z.string().max(100).optional(),
  original: z.unknown().optional(),
});
export const ImportProjectSchema = z.object({
  ...identity,
  name: z.string().min(1).max(200),
  sourcePath: z.string().max(2000).optional(),
  files: z.array(ImportFileSchema).max(10000),
});
export const ImportSessionSchema = z.object({
  ...identity,
  title: z.string().max(500),
  projectId: z.string().max(200).optional(),
  createdAt: z.string().max(100).optional(),
  messages: z.array(ImportMessageSchema).max(20000),
  original: z.unknown().optional(),
});
export const ImportSkillSchema = z.object({
  ...identity,
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  files: z.array(ImportFileSchema).max(1000),
});
export const ImportSensitiveSourceSchema = z.object({
  ...identity,
  name: z.string().min(1).max(200),
  files: z.array(ImportFileSchema).max(1000),
});
export type ImportSensitiveSource = z.infer<typeof ImportSensitiveSourceSchema>;

export const PortableImportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  projects: z.array(ImportProjectSchema).max(100),
  sessions: z.array(ImportSessionSchema).max(1000),
  skills: z.array(ImportSkillSchema).max(1000),
  warnings: z.array(z.string().max(2000)).max(10000),
  includeSensitiveData: z.boolean().optional(),
  sensitiveSources: z.array(ImportSensitiveSourceSchema).max(100).optional(),
});
export type PortableImportBundle = z.infer<typeof PortableImportBundleSchema>;
export type ImportProject = z.infer<typeof ImportProjectSchema>;
export type ImportSession = z.infer<typeof ImportSessionSchema>;
export type ImportSkill = z.infer<typeof ImportSkillSchema>;

export const ImportPacketSchema = z.object({
  encoding: z.literal("gzip-base64"),
  data: z.string().min(1).max(PORTABLE_IMPORT_MAX_PACKET_CHARS),
  includeSensitiveData: z.boolean().optional(),
});
export type ImportPacket = z.infer<typeof ImportPacketSchema>;
export const ImportSelectionSchema = z.object({
  projectIds: z.array(z.string().min(1).max(200)).max(100),
  sessionIds: z.array(z.string().min(1).max(200)).max(1000),
  skillIds: z.array(z.string().min(1).max(200)).max(1000),
  includeSensitiveData: z.boolean().optional(),
  sensitiveSourceIds: z.array(z.string().min(1).max(200)).max(100).optional(),
});
export type ImportSelection = z.infer<typeof ImportSelectionSchema>;

export const ImportProjectSummarySchema = ImportProjectSchema.omit({ files: true }).extend({
  fileCount: z.number().int().nonnegative().nullable(),
});
export const ImportSessionSummarySchema = ImportSessionSchema.omit({
  messages: true,
  original: true,
}).extend({ messageCount: z.number().int().nonnegative().nullable() });
export const ImportSkillSummarySchema = ImportSkillSchema.omit({ files: true }).extend({
  fileCount: z.number().int().nonnegative().nullable(),
});
export const ImportPreviewSchema = z.object({
  projects: z.array(ImportProjectSummarySchema),
  sessions: z.array(ImportSessionSummarySchema),
  skills: z.array(ImportSkillSummarySchema),
  warnings: z.array(z.string()),
  includeSensitiveData: z.boolean().optional(),
  sensitiveSources: z
    .array(
      ImportSensitiveSourceSchema.omit({ files: true }).extend({
        fileCount: z.number().int().nonnegative().nullable(),
      }),
    )
    .optional(),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export const LocalImportScanSchema = ImportPreviewSchema.extend({
  sources: z.array(
    z.object({ source: LocalImportSourceSchema, label: z.string(), available: z.boolean() }),
  ),
});
export type LocalImportScan = z.infer<typeof LocalImportScanSchema>;
export const ImportReceiptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string().datetime(),
  projectCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  includeSensitiveData: z.boolean().optional(),
  sensitiveFileCount: z.number().int().nonnegative().optional(),
});
export type ImportReceipt = z.infer<typeof ImportReceiptSchema>;
export const ImportArchiveSchema = z.object({
  receipt: ImportReceiptSchema,
  bundle: PortableImportBundleSchema,
});
