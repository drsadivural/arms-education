/**
 * Validates API responses against the effective OpenAPI contract (packages/contracts/openapi.json).
 * Use in every endpoint test: expectContract(res, "get", "/teachers/{id}").
 */
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import spec from "../../../../packages/contracts/openapi.json";

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema({ ...(spec as object), $id: "openapi" } as never);

const cache = new Map<string, ReturnType<typeof ajv.compile>>();

export function expectContract(res: { status: number; body: unknown }, method: string, path: string): void {
  const op = (spec as any).paths?.[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`No contract operation for ${method.toUpperCase()} ${path}`);
  const status = String(res.status);
  const response = op.responses?.[status];
  if (!response) throw new Error(`Status ${status} is not declared for ${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`);
  const key = `${method} ${path} ${status}`;
  let validate = cache.get(key);
  if (!validate) {
    const pointer = response.$ref
      ? `openapi${response.$ref}/content/application~1json/schema`
      : `openapi#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
    validate = ajv.compile({ $ref: pointer });
    cache.set(key, validate);
  }
  const valid = validate(res.body);
  expect(valid, `${key} contract violation: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(res.body).slice(0, 2000)}`).toBe(true);
}
