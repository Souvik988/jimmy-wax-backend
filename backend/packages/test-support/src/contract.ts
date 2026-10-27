import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

export const SPEC_PATH = resolve(import.meta.dirname, '../../../../contracts/api/openapi.yaml');
export const specSha256 = () => createHash('sha256').update(readFileSync(SPEC_PATH)).digest('hex');

type Api = {
  components: { responses: { Error: { content: { 'application/json': { schema: object } } } } };
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, { schema?: object }> }> }>
  >;
};
let cached: Promise<{ api: Api; ajv: Ajv }> | null = null;

async function load() {
  cached ??= (async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Api;
    const ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: Ajv) => void)(ajv);
    return { api, ajv };
  })();
  return cached;
}

/** Asserts a REAL response body conforms to the documented schema for (method, template path, status). */
export async function conforms(
  method: string,
  templatePath: string,
  status: number,
  body: unknown,
): Promise<string[]> {
  const { api, ajv } = await load();
  const op = api.paths[templatePath]?.[method.toLowerCase()];
  if (!op) return [`undocumented operation ${method} ${templatePath}`];
  // Documented globally in info.description: any operation may also return these with ErrorBody.
  const GLOBAL = [400, 401, 403, 429, 500, 503];
  const resp =
    op.responses?.[String(status)] ?? (GLOBAL.includes(status) ? api.components.responses.Error : undefined);
  if (!resp) return [`undocumented status ${status} for ${method} ${templatePath}`];
  const schema = resp.content?.['application/json']?.schema;
  if (!schema) return [];
  const validate = ajv.compile(schema);
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}
