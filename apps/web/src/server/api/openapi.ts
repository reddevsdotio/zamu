// The OpenAPI 3.1 document of /api/v1, generated from the contract and served at /api/v1/openapi.json.
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import {
  contract,
  MilestonePlan,
  MilestoneWithProgress,
  Problem,
  Task,
  TaskListItem,
  Wave,
} from '@zamu/contracts';

export const OPENAPI_PATH = '/api/v1/openapi.json';

type OpenAPIDocument = Awaited<ReturnType<OpenAPIGenerator['generate']>>;
type GenerateOptions = NonNullable<Parameters<OpenAPIGenerator['generate']>[1]>;

const PROBLEM_REF = {
  $ref: '#/components/schemas/Problem',
} as GenerateOptions['customErrorResponseBodySchema'];

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });

export function generateOpenApiDocument(): Promise<OpenAPIDocument> {
  return generator.generate(contract, {
    info: {
      title: 'Zamu API',
      version: '1',
      description:
        'REST API of Zamu. Authenticate with an API key (`Authorization: Bearer zamu_live_...`) ' +
        'or, from the web app, the session cookie. Errors use application/problem+json style bodies ' +
        '(RFC 9457) with `code`, `requestId` and `issues`.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key created in Settings → API keys, starting with zamu_live_.',
        },
        session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
      },
    },
    security: [{ apiKey: [] }, { session: [] }],
    // Shared components. Problem carries a Task (TASK_CHANGED), so inlining it in every error
    // response of every operation would repeat the Task schema about 150 times. M8: task rows, the
    // milestone, its plan and a wave are shared too, as several routes return each of them.
    commonSchemas: {
      Problem: { schema: Problem, strategy: 'output' },
      Task: { schema: Task, strategy: 'output' },
      TaskListItem: { schema: TaskListItem, strategy: 'output' },
      MilestoneWithProgress: { schema: MilestoneWithProgress, strategy: 'output' },
      Wave: { schema: Wave, strategy: 'output' },
      MilestonePlan: { schema: MilestonePlan, strategy: 'output' },
    },
    // Every error status shares the Problem body instead of oRPC's default error shape.
    customErrorResponseBodySchema: PROBLEM_REF,
  });
}

let cached: Promise<OpenAPIDocument> | undefined;

/** The document, generated once per process. */
export function getOpenApiDocument(): Promise<OpenAPIDocument> {
  cached ??= generateOpenApiDocument().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
