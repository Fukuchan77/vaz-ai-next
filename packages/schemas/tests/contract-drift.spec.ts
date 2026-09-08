import { readFile } from "node:fs/promises";
import {
	evalRequestSchema,
	evalResponseSchema,
	tokenUsageSchema,
} from "@vaz/schemas/agent-service";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { z } from "zod";

/**
 * Single-point contract-drift test (Req 3.4, ADR-B). `services/agent/app/schemas.py`
 * (Pydantic) is this HTTP boundary's sole source of truth; three derived artifacts must
 * still agree with each other and with it: the committed OpenAPI snapshot, the committed
 * openapi-typescript output generated from that snapshot, and the thin hand-written Zod
 * schemas. Regenerating the snapshot without re-running `openapi:gen`, hand-editing the
 * generated file, or leaving a thin Zod schema behind after a Pydantic change all surface
 * as this one test failing (mirrors the sandbox `test_contract_drift.py` shape referenced
 * in research.md).
 */

const GENERATED_DIR = new URL("../src/generated/", import.meta.url);
const SNAPSHOT_PATH = new URL("openapi.snapshot.json", GENERATED_DIR);
const GENERATED_TYPES_PATH = new URL("agent-service.ts", GENERATED_DIR);

interface JsonSchemaLike {
	type?: string;
	$ref?: string;
	required?: string[];
	properties?: Record<string, JsonSchemaLike>;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
}

interface PropertyShape {
	type: string | undefined;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
}

interface SchemaShape {
	type: string | undefined;
	required: string[];
	properties: Record<string, PropertyShape>;
}

function resolveRef(
	schema: JsonSchemaLike,
	components: Record<string, JsonSchemaLike>,
): JsonSchemaLike {
	if (!schema.$ref) {
		return schema;
	}
	const name = schema.$ref.split("/").pop();
	const resolved = name ? components[name] : undefined;
	if (!resolved) {
		throw new Error(`Unresolvable $ref: ${schema.$ref}`);
	}
	return resolved;
}

// zod v4's `.int()` implicitly adds `maximum: Number.MAX_SAFE_INTEGER` to its
// JSON Schema output on every unsigned-int field, regardless of whether an
// explicit upper bound was declared. Pydantic never emits this artifact
// unless a real `le=`/`lt=` constraint is set, so comparing `maximum`
// symmetrically would flag every plain `int_field: int = Field(ge=0)` as
// drifted. Drop the artifact rather than the whole `maximum` comparison, so
// a genuine bound mismatch (e.g. Pydantic `le=1.0` vs. Zod `.max(5)`) is
// still caught.
const ZOD_IMPLICIT_INT_MAX = Number.MAX_SAFE_INTEGER;

function propertyShape(
	schema: JsonSchemaLike,
	components: Record<string, JsonSchemaLike>,
): PropertyShape {
	const resolved = resolveRef(schema, components);
	const shape: PropertyShape = { type: resolved.type };
	if (resolved.minLength !== undefined) shape.minLength = resolved.minLength;
	if (resolved.maxLength !== undefined) shape.maxLength = resolved.maxLength;
	if (resolved.minItems !== undefined) shape.minItems = resolved.minItems;
	if (resolved.maxItems !== undefined) shape.maxItems = resolved.maxItems;
	if (resolved.minimum !== undefined) shape.minimum = resolved.minimum;
	if (resolved.maximum !== undefined && resolved.maximum !== ZOD_IMPLICIT_INT_MAX) {
		shape.maximum = resolved.maximum;
	}
	return shape;
}

function shapeOf(schema: JsonSchemaLike, components: Record<string, JsonSchemaLike>): SchemaShape {
	const resolved = resolveRef(schema, components);
	const properties = resolved.properties ?? {};
	return {
		type: resolved.type,
		required: [...(resolved.required ?? [])].sort(),
		properties: Object.fromEntries(
			Object.entries(properties).map(([key, value]) => [key, propertyShape(value, components)]),
		),
	};
}

describe("agent-service contract drift (snapshot <-> generated types <-> thin Zod)", () => {
	test("snapshot, generated TS types, and thin Zod schemas describe the same boundary shapes", async () => {
		const snapshotText = await readFile(SNAPSHOT_PATH, "utf8");
		const components = (
			JSON.parse(snapshotText) as { components: { schemas: Record<string, JsonSchemaLike> } }
		).components.schemas;

		// Leg 1 (snapshot <-> generated types): regenerating from the committed
		// snapshot with openapi-typescript's own defaults — the same invocation
		// `mise run openapi:gen` performs — must byte-match the committed file.
		const regeneratedTypes = `${COMMENT_HEADER}${astToString(
			await openapiTS(JSON.parse(snapshotText), { silent: true }),
		)}`;
		const committedTypes = await readFile(GENERATED_TYPES_PATH, "utf8");
		// X-11: tell the developer how to fix a drift failure, not just that one
		// happened — `services/agent/app/schemas.py` changed (or the generated
		// file was hand-edited) without re-running codegen.
		expect(
			regeneratedTypes,
			"Drift detected: run `mise run openapi:gen` to regenerate " +
				"packages/schemas/src/generated/{openapi.snapshot.json,agent-service.ts} " +
				"from services/agent/app/schemas.py, then commit the result.",
		).toBe(committedTypes);

		// Leg 2 (snapshot <-> thin Zod): property keys, required sets, JSON
		// Schema `type`s, and value constraints (minLength/maxLength/minItems/
		// maxItems/minimum/maximum) must match 1:1 once `$ref`s are resolved —
		// catching drift in the hand-transcribed constraints (e.g. Pydantic's
		// `le=1.0` vs. Zod's `.max(...)`), not just field shape. Compile-time
		// `satisfies z.ZodType<...>` in agent-service.ts already pins generated
		// types <-> thin Zod, so this closes the loop back to the snapshot.
		const cases: ReadonlyArray<[string, z.ZodType]> = [
			["TokenUsage", tokenUsageSchema],
			["EvalRequest", evalRequestSchema],
			["EvalResponse", evalResponseSchema],
		];
		for (const [name, schema] of cases) {
			const fromSnapshot = shapeOf(components[name], components);
			const fromZod = shapeOf(z.toJSONSchema(schema) as JsonSchemaLike, components);
			expect(fromZod).toEqual(fromSnapshot);
		}
	});
});
