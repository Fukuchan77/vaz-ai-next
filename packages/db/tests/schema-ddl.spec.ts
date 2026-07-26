import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	auditLog,
	chunk,
	document,
	EMBEDDING_DIM,
	embedding,
	job,
	jobEvent,
	jobEventTypeEnum,
	jobStatusEnum,
} from "@vaz/db/schema";
import { getTableColumns } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";

/**
 * DDL↔`schema.ts` drift test (R2.2/ADR-0002) — the compensating device for
 * NOT adopting drizzle-kit. Requires no database connection: it parses the
 * hand-written SQL under `packages/db/drizzle/*.sql` (applied in lexical
 * order, baseline + every delta) into a plain model and compares it against
 * `schema.ts`'s tables via `drizzle-orm`'s `getTableColumns`/`getTableConfig`.
 *
 * In scope (byte-for-byte assertion): table set, enum names + ordered value
 * lists, each column's name / SQL type / NOT NULL / DEFAULT-presence, and
 * each foreign key's local column / referenced table+column / ON DELETE
 * action.
 *
 * Out of scope (asserted by *name* only, human review covers the rest):
 * index existence and CHECK constraint existence. Neither an index's method
 * nor op-class, nor a CHECK's expression body, is parsed or compared here —
 * a name-only comparison cannot catch "same name, wrong index method" or
 * "same name, wrong CHECK expression". `packages/db/tests/schema.spec.ts`'s
 * existing "DDL drift guard" describe block already pins the HNSW method +
 * `vector_cosine_ops` op-class and the CHECK's *presence* on the `schema.ts`
 * side; this file adds the SQL side of the table/column/FK comparison that
 * `schema.spec.ts` does not perform.
 */

interface ParsedColumn {
	type: string;
	notNull: boolean;
	hasDefault: boolean;
}

interface ParsedForeignKey {
	column: string;
	refTable: string;
	refColumn: string;
	onDelete: string;
}

interface ParsedTable {
	columns: Map<string, ParsedColumn>;
	foreignKeys: ParsedForeignKey[];
	checkNames: string[];
	indexNames: string[];
}

interface ParsedSchema {
	enums: Map<string, string[]>;
	tables: Map<string, ParsedTable>;
	/** Raw CHECK constraint bodies, keyed by constraint name (for the targeted EMBEDDING_DIM assertion). */
	checkBodies: Map<string, string>;
	/** `drizzle/*.sql` filenames, in the lexical order they were applied. */
	files: string[];
}

function stripSqlComments(sql: string): string {
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n");
}

function splitStatements(sql: string): string[] {
	return stripSqlComments(sql)
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

function parseColumnClause(clause: string): [string, ParsedColumn] {
	const match = clause.match(/^"([^"]+)"\s+(.*)$/);
	if (!match) {
		throw new Error(`schema-ddl.spec.ts: cannot parse column clause: ${clause}`);
	}
	const [, name, rest] = match;
	const notNull = /\bNOT NULL\b/i.test(rest) || /\bPRIMARY KEY\b/i.test(rest);
	const hasDefault = /\bDEFAULT\b/i.test(rest);
	const type = rest
		.replace(/\bPRIMARY KEY\b/gi, "")
		.replace(/\bNOT NULL\b/gi, "")
		.replace(/\bDEFAULT\b.*$/i, "")
		.trim();
	return [name, { type, notNull, hasDefault }];
}

function applyCreateType(schema: ParsedSchema, statement: string): boolean {
	const match = statement.match(/^CREATE TYPE "([^"]+)" AS ENUM\s*\(([^)]*)\)$/i);
	if (!match) return false;
	const [, name, valuesList] = match;
	const values = valuesList.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
	schema.enums.set(name, values);
	return true;
}

function applyCreateTable(schema: ParsedSchema, statement: string): boolean {
	const match = statement.match(/^CREATE TABLE "([^"]+)"\s*\(([\s\S]+)\)$/i);
	if (!match) return false;
	const [, tableName, body] = match;
	const table: ParsedTable = {
		columns: new Map(),
		foreignKeys: [],
		checkNames: [],
		indexNames: [],
	};
	for (const rawClause of body.split(/,\n/)) {
		const clause = rawClause.trim().replace(/,\s*$/, "");
		if (!clause) continue;
		const fkMatch = clause.match(
			/^CONSTRAINT\s+"[^"]+"\s+FOREIGN KEY\s+\("([^"]+)"\)\s+REFERENCES\s+"([^"]+)"\("([^"]+)"\)\s+ON DELETE\s+([\w ]+)$/i,
		);
		if (fkMatch) {
			const [, column, refTable, refColumn, onDelete] = fkMatch;
			table.foreignKeys.push({
				column,
				refTable,
				refColumn,
				onDelete: onDelete.trim().toLowerCase(),
			});
			continue;
		}
		const checkMatch = clause.match(/^CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\((.+)\)$/i);
		if (checkMatch) {
			const [, checkName, checkBody] = checkMatch;
			table.checkNames.push(checkName);
			schema.checkBodies.set(checkName, checkBody);
			continue;
		}
		const [colName, col] = parseColumnClause(clause);
		table.columns.set(colName, col);
	}
	schema.tables.set(tableName, table);
	return true;
}

function applyCreateIndex(schema: ParsedSchema, statement: string): boolean {
	const match = statement.match(/^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"/i);
	if (!match) return false;
	const [, indexName, tableName] = match;
	const table = schema.tables.get(tableName);
	if (!table) {
		throw new Error(`schema-ddl.spec.ts: index ${indexName} references unknown table ${tableName}`);
	}
	table.indexNames.push(indexName);
	return true;
}

function applyAlterTableAddColumn(schema: ParsedSchema, statement: string): boolean {
	const match = statement.match(/^ALTER TABLE "([^"]+)" ADD COLUMN (.+)$/i);
	if (!match) return false;
	const [, tableName, rest] = match;
	const table = schema.tables.get(tableName);
	if (!table) {
		throw new Error(`schema-ddl.spec.ts: ALTER TABLE references unknown table ${tableName}`);
	}
	const [colName, col] = parseColumnClause(rest);
	table.columns.set(colName, col);
	return true;
}

/** Applies every `drizzle/*.sql` file in lexical order and returns the resulting schema model. */
function parseAppliedSchema(): ParsedSchema {
	const drizzleDir = join(import.meta.dirname, "..", "drizzle");
	const files = readdirSync(drizzleDir)
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const schema: ParsedSchema = {
		enums: new Map(),
		tables: new Map(),
		checkBodies: new Map(),
		files,
	};
	for (const file of files) {
		const content = readFileSync(join(drizzleDir, file), "utf8");
		for (const statement of splitStatements(content)) {
			if (/^CREATE EXTENSION\b/i.test(statement)) continue;
			if (applyCreateType(schema, statement)) continue;
			if (applyCreateTable(schema, statement)) continue;
			if (applyCreateIndex(schema, statement)) continue;
			if (applyAlterTableAddColumn(schema, statement)) continue;
			throw new Error(`schema-ddl.spec.ts: unrecognized DDL statement: ${statement}`);
		}
	}
	return schema;
}

function tableModelFromDrizzle(table: AnyPgTable): ParsedTable {
	const columns = new Map<string, ParsedColumn>();
	for (const column of Object.values(getTableColumns(table))) {
		columns.set(column.name, {
			type: column.getSQLType(),
			notNull: column.notNull,
			hasDefault: column.hasDefault,
		});
	}
	const config = getTableConfig(table);
	const foreignKeys: ParsedForeignKey[] = config.foreignKeys.map((fk) => {
		const ref = fk.reference();
		return {
			column: ref.columns[0]?.name ?? "",
			refTable: getTableConfig(ref.foreignTable).name,
			refColumn: ref.foreignColumns[0]?.name ?? "",
			onDelete: (fk.onDelete ?? "no action").toLowerCase(),
		};
	});
	return {
		columns,
		foreignKeys,
		checkNames: config.checks.map((c) => c.name),
		indexNames: config.indexes.map((idx) => idx.config.name ?? ""),
	};
}

const TABLES: Record<string, AnyPgTable> = {
	document,
	chunk,
	embedding,
	job,
	job_event: jobEvent,
	audit_log: auditLog,
};

describe("DDL↔schema.ts drift (R2.2, no DB connection)", () => {
	const applied = parseAppliedSchema();

	test("applies baseline + delta files in lexical order (baseline before the locator delta)", () => {
		expect(applied.files).toEqual(["0000_baseline.sql", "0001_add_locator.sql"]);
	});

	test("table set matches schema.ts exactly", () => {
		expect([...applied.tables.keys()].sort()).toEqual(Object.keys(TABLES).sort());
	});

	test("enum names and ordered value lists match schema.ts exactly", () => {
		expect(applied.enums.get("job_status")).toEqual(jobStatusEnum.enumValues);
		expect(applied.enums.get("job_event_type")).toEqual(jobEventTypeEnum.enumValues);
		expect([...applied.enums.keys()].sort()).toEqual(["job_event_type", "job_status"]);
	});

	for (const [dbTableName, drizzleTable] of Object.entries(TABLES)) {
		test(`${dbTableName}: columns (name/type/NOT NULL/DEFAULT) match schema.ts`, () => {
			const sqlTable = applied.tables.get(dbTableName);
			if (!sqlTable) throw new Error(`no SQL table found for ${dbTableName}`);
			const drizzleModel = tableModelFromDrizzle(drizzleTable);
			expect([...sqlTable.columns.keys()].sort()).toEqual([...drizzleModel.columns.keys()].sort());
			for (const [columnName, drizzleColumn] of drizzleModel.columns) {
				const sqlColumn = sqlTable.columns.get(columnName);
				expect(sqlColumn, `${dbTableName}.${columnName} missing from SQL`).toBeDefined();
				expect(sqlColumn?.type.toLowerCase()).toBe(drizzleColumn.type.toLowerCase());
				expect(sqlColumn?.notNull).toBe(drizzleColumn.notNull);
				expect(sqlColumn?.hasDefault).toBe(drizzleColumn.hasDefault);
			}
		});

		test(`${dbTableName}: foreign keys (column/refTable/refColumn/ON DELETE) match schema.ts`, () => {
			const sqlTable = applied.tables.get(dbTableName);
			if (!sqlTable) throw new Error(`no SQL table found for ${dbTableName}`);
			const drizzleModel = tableModelFromDrizzle(drizzleTable);
			expect(sqlTable.foreignKeys).toEqual(drizzleModel.foreignKeys);
		});

		test(`${dbTableName}: index and CHECK constraint names exist (existence only — see file docstring for scope)`, () => {
			const sqlTable = applied.tables.get(dbTableName);
			if (!sqlTable) throw new Error(`no SQL table found for ${dbTableName}`);
			const drizzleModel = tableModelFromDrizzle(drizzleTable);
			expect(sqlTable.indexNames.sort()).toEqual(drizzleModel.indexNames.sort());
			expect(sqlTable.checkNames.sort()).toEqual(drizzleModel.checkNames.sort());
		});
	}

	test("EMBEDDING_DIM matches embedding.vector's vector(N) and the embedding_dim_fixed CHECK's `= N` (no drift)", () => {
		const embeddingColumns = applied.tables.get("embedding")?.columns;
		expect(embeddingColumns?.get("vector")?.type.toLowerCase()).toBe(`vector(${EMBEDDING_DIM})`);
		const checkBody = applied.checkBodies.get("embedding_dim_fixed");
		expect(checkBody).toContain(`= ${EMBEDDING_DIM}`);
	});
});
