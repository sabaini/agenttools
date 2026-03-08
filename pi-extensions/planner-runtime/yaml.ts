import fs from "node:fs/promises";
import fsSync from "node:fs";
import { parseDocument, stringify } from "yaml";

function normalizeYamlError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function parseYamlContent(raw: string, filePath: string): unknown {
	let document;
	try {
		document = parseDocument(raw, {
			prettyErrors: false,
			strict: false,
			merge: true,
		});
	} catch (error) {
		throw new Error(`Invalid YAML in ${filePath}: ${normalizeYamlError(error)}`);
	}

	if (document.errors.length > 0) {
		throw new Error(`Invalid YAML in ${filePath}: ${document.errors[0]?.message ?? "unknown parse error"}`);
	}

	return document.toJSON();
}

export async function loadYamlFile(filePath: string): Promise<unknown> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable YAML file: ${filePath}`);
	}

	return parseYamlContent(raw, filePath);
}

export function loadYamlFileSync(filePath: string): unknown {
	let raw: string;
	try {
		raw = fsSync.readFileSync(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable YAML file: ${filePath}`);
	}

	return parseYamlContent(raw, filePath);
}

export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
	const content = stringify(value, {
		indent: 2,
		lineWidth: 0,
		singleQuote: false,
	});
	await fs.writeFile(filePath, content, "utf8");
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed || undefined;
}

export function asStringArray(value: unknown): string[] {
	return asArray(value)
		.map((entry) => asString(entry))
		.filter((entry): entry is string => Boolean(entry));
}
