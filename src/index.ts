#!/usr/bin/env node
/**
 * GetMyCert MCP Server
 *
 * Exposes GetMyCert.com's IT certification practice question API as a
 * Model Context Protocol server. Any MCP-compatible agent (Claude Desktop,
 * Claude Code, Cursor, Windsurf, etc.) can mount this server and call
 * `get_cert_questions` to fetch real practice questions on demand.
 *
 * Two payment paths are supported with automatic fallback:
 *   1. x402 micropayments — pay-per-call USDC on Base, no signup required.
 *   2. Prepaid API key     — traditional `x-api-key` header against the
 *                            Supabase edge function.
 *
 * See README.md for setup instructions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createWalletClient,
  http,
  publicActions,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_X402_URL = "https://getmycert.com/api/v1/x402";
const DEFAULT_API_URL =
  "https://akcrbmxlnlcgvsgainib.supabase.co/functions/v1/api-v1-questions";
const DEFAULT_CERTS_URL = "https://getmycert.com/api/v1/certifications";
const DEFAULT_RPC_URL = "https://mainnet.base.org";
const DEFAULT_MAX_PAYMENT = 100_000n; // 0.10 USDC in 6-decimal micro-units

const config = {
  x402Url: process.env.GETMYCERT_X402_URL ?? DEFAULT_X402_URL,
  apiUrl: process.env.GETMYCERT_API_URL ?? DEFAULT_API_URL,
  certsUrl: process.env.GETMYCERT_CERTS_URL ?? DEFAULT_CERTS_URL,
  rpcUrl: process.env.GETMYCERT_RPC_URL ?? DEFAULT_RPC_URL,
  apiKey: process.env.GETMYCERT_API_KEY,
  walletPrivateKey: normalizePrivateKey(process.env.GETMYCERT_WALLET_PRIVATE_KEY),
  maxPayment: parseBigInt(process.env.GETMYCERT_MAX_PAYMENT, DEFAULT_MAX_PAYMENT),
};

function normalizePrivateKey(raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Reject the placeholder zero key from .env.example so users don't ship it.
  if (/^0x?0+$/.test(trimmed)) return undefined;
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) return undefined;
  return withPrefix as Hex;
}

function parseBigInt(raw: string | undefined, fallback: bigint): bigint {
  if (!raw) return fallback;
  try {
    return BigInt(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Cert slug catalog (kept in sync with the live API; list_certifications
// also queries the live endpoint for the authoritative answer)
// ---------------------------------------------------------------------------

const CERT_SLUGS = [
  "aws-saa",
  "aws-sysops",
  "aws-developer",
  "aws-cloud-practitioner",
  "aws-solutions-architect-pro",
  "comptia-a-plus",
  "comptia-network-plus",
  "comptia-security-plus",
  "comptia-cysa-plus",
  "casp-plus",
  "pentest-plus",
  "cloud-plus",
  "data-plus",
  "linux-plus",
  "server-plus",
  "google-cloud-ace",
  "google-cloud-pca",
  "azure-fundamentals",
  "azure-administrator",
  "azure-developer",
  "azure-security",
  "cisco-ccna",
  "kubernetes-ckad",
  "pmp",
  "cissp",
  "ceh",
  "itil-4",
] as const;

// ---------------------------------------------------------------------------
// Tool input schemas (zod) — also used to build the JSON Schema for MCP
// ---------------------------------------------------------------------------

const GetCertQuestionsInput = z.object({
  certification: z
    .string()
    .min(1)
    .describe(
      "Cert slug e.g. 'aws-saa', 'comptia-security-plus'. Use list_certifications to see all options."
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .default(10)
    .describe("Number of questions to return (1-25, default 10)."),
  difficulty: z
    .enum(["easy", "medium", "hard"])
    .optional()
    .describe("Optional difficulty filter."),
  include_answers: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include correct answer and explanation (default true)."),
});

type GetCertQuestionsArgs = z.infer<typeof GetCertQuestionsInput>;

// ---------------------------------------------------------------------------
// Types describing the API response shape
// ---------------------------------------------------------------------------

interface QuestionOption {
  label: string; // "A" | "B" | ...
  text: string;
}

interface CertQuestion {
  id?: string;
  question: string;
  options: QuestionOption[] | Record<string, string> | string[];
  correct_answer?: string;
  answer?: string;
  explanation?: string;
  difficulty?: "easy" | "medium" | "hard";
  domain?: string;
}

interface QuestionsResponse {
  certification?: string;
  questions: CertQuestion[];
  count?: number;
  remaining_credits?: number;
}

interface CertificationListItem {
  slug: string;
  name: string;
  question_count?: number;
  vendor?: string;
  category?: string;
}

interface CertificationsResponse {
  certifications: CertificationListItem[];
  total?: number;
}

interface X402Requirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra?: { name?: string; version?: string };
}

interface X402Challenge {
  x402Version: number;
  error: string;
  accepts: X402Requirement[];
}

// ---------------------------------------------------------------------------
// USDC EIP-3009 (transferWithAuthorization) helpers — the x402 "exact" scheme
// signs an EIP-712 authorization that the facilitator submits on-chain.
// ---------------------------------------------------------------------------

interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

async function signX402Payment(
  wallet: WalletClient,
  account: ReturnType<typeof privateKeyToAccount>,
  requirement: X402Requirement
): Promise<string> {
  const value = BigInt(requirement.maxAmountRequired);
  if (value > config.maxPayment) {
    throw new Error(
      `x402 server requested ${value} micro-USDC which exceeds GETMYCERT_MAX_PAYMENT (${config.maxPayment}). ` +
        `Raise the cap if this is expected.`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const auth: TransferAuthorization = {
    from: account.address,
    to: requirement.payTo,
    value,
    validAfter: 0n,
    validBefore: BigInt(now + requirement.maxTimeoutSeconds),
    nonce: randomNonce(),
  };

  const domain = {
    name: requirement.extra?.name ?? "USD Coin",
    version: requirement.extra?.version ?? "2",
    chainId: base.id,
    verifyingContract: requirement.asset,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const signature = await wallet.signTypedData({
    account,
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  });

  // x402 "exact" scheme payload — base64-encoded JSON header value.
  const payload = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Wallet bootstrap (lazy — only built if a private key is configured)
// ---------------------------------------------------------------------------

let walletBundle:
  | { wallet: WalletClient; account: ReturnType<typeof privateKeyToAccount> }
  | null
  | undefined;

function getWallet() {
  if (walletBundle !== undefined) return walletBundle;
  if (!config.walletPrivateKey) {
    walletBundle = null;
    return walletBundle;
  }
  const account = privateKeyToAccount(config.walletPrivateKey);
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl),
  }).extend(publicActions);
  walletBundle = { wallet, account };
  return walletBundle;
}

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------

function buildQueryString(args: GetCertQuestionsArgs): string {
  const params = new URLSearchParams();
  params.set("certification", args.certification);
  params.set("count", String(args.count ?? 10));
  if (args.difficulty) params.set("difficulty", args.difficulty);
  params.set("include_answers", String(args.include_answers ?? true));
  return params.toString();
}

async function fetchViaX402(args: GetCertQuestionsArgs): Promise<QuestionsResponse> {
  const bundle = getWallet();
  if (!bundle) throw new Error("Wallet not configured");
  const { wallet, account } = bundle;

  const url = `${config.x402Url}?${buildQueryString(args)}`;

  // First request — expect 402 with challenge.
  const probe = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (probe.ok) {
    // Some configurations may allow free access; pass through.
    return (await probe.json()) as QuestionsResponse;
  }

  if (probe.status !== 402) {
    const body = await safeReadText(probe);
    throw new Error(
      `x402 endpoint returned ${probe.status} ${probe.statusText}: ${body}`
    );
  }

  const challenge = (await probe.json()) as X402Challenge;
  const requirement = challenge.accepts?.find(
    (r) => r.scheme === "exact" && r.network.startsWith("base")
  );
  if (!requirement) {
    throw new Error(
      "x402 challenge did not advertise an 'exact' scheme on Base. " +
        `Received: ${JSON.stringify(challenge.accepts)}`
    );
  }

  const paymentHeader = await signX402Payment(wallet, account, requirement);

  const paid = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-PAYMENT": paymentHeader,
    },
  });

  if (!paid.ok) {
    const body = await safeReadText(paid);
    throw new Error(
      `x402 paid request failed: ${paid.status} ${paid.statusText} — ${body}`
    );
  }

  return (await paid.json()) as QuestionsResponse;
}

async function fetchViaApiKey(args: GetCertQuestionsArgs): Promise<QuestionsResponse> {
  if (!config.apiKey) throw new Error("API key not configured");
  const url = `${config.apiUrl}?${buildQueryString(args)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-api-key": config.apiKey,
    },
  });
  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(
      `GetMyCert API returned ${res.status} ${res.statusText}: ${body}`
    );
  }
  return (await res.json()) as QuestionsResponse;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function normalizeOptions(
  raw: CertQuestion["options"]
): { label: string; text: string }[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (typeof raw[0] === "string") {
      return (raw as string[]).map((text, i) => ({
        label: String.fromCharCode(65 + i),
        text,
      }));
    }
    return (raw as QuestionOption[]).map((o, i) => ({
      label: o.label ?? String.fromCharCode(65 + i),
      text: o.text,
    }));
  }
  // Object map: { A: "...", B: "..." }
  return Object.entries(raw).map(([label, text]) => ({
    label,
    text: String(text),
  }));
}

function formatQuestions(
  args: GetCertQuestionsArgs,
  data: QuestionsResponse
): string {
  if (!data.questions?.length) {
    return `No questions returned for ${args.certification}.`;
  }

  const header = [
    `Certification: ${data.certification ?? args.certification}`,
    `Questions: ${data.questions.length}`,
    args.difficulty ? `Difficulty filter: ${args.difficulty}` : null,
    data.remaining_credits !== undefined
      ? `Remaining credits: ${data.remaining_credits}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const body = data.questions
    .map((q, idx) => {
      const opts = normalizeOptions(q.options);
      const lines: string[] = [];
      const diff = q.difficulty ? ` (${q.difficulty})` : "";
      lines.push(`Question ${idx + 1}${diff}: ${q.question}`);
      for (const o of opts) lines.push(`${o.label}) ${o.text}`);
      if (args.include_answers !== false) {
        const correct = q.correct_answer ?? q.answer;
        if (correct) {
          const expl = q.explanation ? ` — ${q.explanation}` : "";
          lines.push(`Answer: ${correct}${expl}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${body}`;
}

function formatCertifications(data: CertificationsResponse): string {
  if (!data.certifications?.length) return "No certifications available.";
  const total = data.total ?? data.certifications.length;
  const rows = data.certifications
    .map((c) => {
      const count = c.question_count ? ` — ${c.question_count} questions` : "";
      const vendor = c.vendor ? ` [${c.vendor}]` : "";
      return `  ${c.slug}${vendor}: ${c.name}${count}`;
    })
    .join("\n");
  return `GetMyCert.com — ${total} certifications available:\n\n${rows}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function getCertQuestionsTool(rawArgs: unknown): Promise<string> {
  const args = GetCertQuestionsInput.parse(rawArgs);

  if (!CERT_SLUGS.includes(args.certification as (typeof CERT_SLUGS)[number])) {
    // Warn but still attempt — server is authoritative.
    process.stderr.write(
      `[getmycert-mcp] Unknown cert slug '${args.certification}'. Attempting anyway.\n`
    );
  }

  const errors: string[] = [];
  const haveWallet = !!getWallet();
  const haveApiKey = !!config.apiKey;

  if (!haveWallet && !haveApiKey) {
    throw new Error(
      "GetMyCert MCP server has no credentials configured. Set either " +
        "GETMYCERT_WALLET_PRIVATE_KEY (x402 payments) or GETMYCERT_API_KEY " +
        "(prepaid key). See README for setup."
    );
  }

  if (haveWallet) {
    try {
      const data = await fetchViaX402(args);
      return formatQuestions(args, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`x402 path failed: ${msg}`);
      process.stderr.write(`[getmycert-mcp] ${errors[errors.length - 1]}\n`);
    }
  }

  if (haveApiKey) {
    try {
      const data = await fetchViaApiKey(args);
      return formatQuestions(args, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`API-key path failed: ${msg}`);
    }
  }

  throw new Error(
    `Could not fetch questions. ${errors.join(" | ")}`
  );
}

async function listCertificationsTool(): Promise<string> {
  try {
    const res = await fetch(config.certsUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Certifications endpoint returned ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as CertificationsResponse;
    return formatCertifications(data);
  } catch (err) {
    // Fallback to the bundled slug list so the tool still produces something.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[getmycert-mcp] list_certifications live fetch failed: ${msg}\n`
    );
    const fallback: CertificationsResponse = {
      certifications: CERT_SLUGS.map((slug) => ({ slug, name: slug })),
      total: CERT_SLUGS.length,
    };
    return (
      formatCertifications(fallback) +
      `\n\n(Live API unreachable: ${msg}. Showing bundled catalog.)`
    );
  }
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "get_cert_questions",
    description:
      "Get IT certification practice questions from GetMyCert.com. Supports 27 major " +
      "IT certifications including AWS, CompTIA, Google Cloud, Azure, and Cisco. Returns " +
      "multiple-choice questions with options and explanations.",
    inputSchema: {
      type: "object",
      properties: {
        certification: {
          type: "string",
          description:
            "Cert slug e.g. 'aws-saa', 'comptia-security-plus'. Call list_certifications for all options.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          default: 10,
          description: "Number of questions to return (1-25, default 10).",
        },
        difficulty: {
          type: "string",
          enum: ["easy", "medium", "hard"],
          description: "Optional difficulty filter.",
        },
        include_answers: {
          type: "boolean",
          default: true,
          description: "Include correct answer and explanation (default true).",
        },
      },
      required: ["certification"],
      additionalProperties: false,
    },
  },
  {
    name: "list_certifications",
    description:
      "List all available IT certifications on GetMyCert.com with question counts. " +
      "Use this to discover valid `certification` slugs for get_cert_questions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export function createServer(): Server {
  const server = new Server(
    {
      name: "getmycert-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      try {
        let text: string;
        switch (name) {
          case "get_cert_questions":
            text = await getCertQuestionsTool(args ?? {});
            break;
          case "list_certifications":
            text = await listCertificationsTool();
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `GetMyCert MCP error in '${name}': ${msg}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry point — stdio transport. (HTTP transport is exported via createServer
// so a hosted deployment can wrap it in its own transport.)
// ---------------------------------------------------------------------------

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[getmycert-mcp] Server ready on stdio.\n");
}

// Run only when invoked directly (not when imported by an HTTP wrapper).
const isDirectRun = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const url = new URL(import.meta.url).pathname;
    return url === argv1 || url.endsWith(argv1.replace(/^.*[\\\/]/, ""));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(
      `[getmycert-mcp] Fatal: ${err instanceof Error ? err.stack : String(err)}\n`
    );
    process.exit(1);
  });
}

export { TOOLS, getCertQuestionsTool, listCertificationsTool };
