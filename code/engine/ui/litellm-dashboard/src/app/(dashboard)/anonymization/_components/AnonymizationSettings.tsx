import React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SettingRow {
  name: string;
  description: string;
  fallback: string;
}

const DETECTION_SETTINGS: SettingRow[] = [
  {
    name: "presidio_analyzer_api_base",
    description: "Presidio analyzer used for the rule-based first stage.",
    fallback: "PRESIDIO_ANALYZER_API_BASE",
  },
  {
    name: "pii_ner_api_base",
    description:
      "Second-stage NER inference server speaking the HuggingFace token-classification contract. Leave unset to run rules only.",
    fallback: "LITELLM_PII_NER_API_BASE",
  },
  {
    name: "pii_ner_stage_policy",
    description:
      "When the model stage runs: never, on_miss (default), on_low_confidence, or always. on_miss keeps most requests on the cheap deterministic pass.",
    fallback: "LITELLM_PII_NER_STAGE_POLICY",
  },
  {
    name: "pii_ner_score_threshold",
    description: "Minimum confidence for a model-based detection, and the cutoff used by on_low_confidence.",
    fallback: "defaults to 0.5",
  },
];

const CODEC_SETTINGS: SettingRow[] = [
  {
    name: "pii_codec",
    description:
      "Token format. placeholder emits <PERSON_1> and keeps model output quality high. handle emits an opaque random token. encrypted carries its own ciphertext and needs no store.",
    fallback: "defaults to placeholder",
  },
  {
    name: "pii_fail_closed",
    description:
      "Reject the request when a detector is unreachable rather than forwarding it unscanned. Turning this off can send unredacted PII to the provider during an outage.",
    fallback: "defaults to true",
  },
  {
    name: "LITELLM_PII_ENCRYPTION_KEY",
    description:
      "Secret used to seal stored PII values at rest with AES-256-GCM. Without it, values are stored unencrypted.",
    fallback: "environment only",
  },
  {
    name: "LITELLM_PII_SESSION_TTL_SECONDS",
    description: "How long /pii/encode tokens stay resolvable by /pii/decode.",
    fallback: "defaults to 24 hours",
  },
];

const VAULT_SETTINGS: SettingRow[] = [
  {
    name: "LITELLM_PII_VAULT_ENABLED",
    description:
      "Persist token mappings in the database instead of the cache, so they survive a restart and can be revoked, exported and searched. Off by default.",
    fallback: "defaults to false",
  },
  {
    name: "LITELLM_PII_RETENTION_DAYS",
    description:
      "How long a stored mapping stays resolvable. Enforced twice: filtered in the read query so an expired row can never resolve even if cleanup is behind, and swept by a background job.",
    fallback: "defaults to 30 days",
  },
  {
    name: "LITELLM_PII_VAULT_SCOPE",
    description:
      "Default scope for newly minted tokens: key, user, team or organization. key is the most restrictive, so widening is always a deliberate choice. A caller can only mint at a scope it belongs to.",
    fallback: "defaults to key",
  },
  {
    name: "LITELLM_PII_KEY_VERSION",
    description:
      "Version new writes are encrypted at. Rotation is lazy: raising this changes new writes only, and each read uses whatever version its row names, so there is no migration window.",
    fallback: "defaults to 1",
  },
  {
    name: "LITELLM_PII_SEARCH_CANDIDATE_CAP",
    description:
      "Largest number of rows /pii/search will scan before refusing. A query over the cap is refused rather than run slowly or truncated silently.",
    fallback: "defaults to 100000",
  },
  {
    name: "LITELLM_SALT_KEY",
    description:
      "Root secret the per-scope vault keys are derived from with HKDF-SHA256, falling back to the master key. Compromising one scope's key yields nothing about another's.",
    fallback: "falls back to master_key",
  },
];

const PERMISSIONS: SettingRow[] = [
  {
    name: "allow_pii_decode",
    description: "Resolve tokens this key's scope owns. Decode hands back real PII, so it is opt-in per key.",
    fallback: "key permission",
  },
  {
    name: "allow_pii_decode_any",
    description:
      "Break glass: read a scope the key does not belong to. Off by default, and every use is recorded as such in the audit log.",
    fallback: "key permission",
  },
  {
    name: "allow_pii_search",
    description:
      "Search the vault for a value. Separate from decode because finding which tokens hold a value is strictly more powerful than resolving one you already have.",
    fallback: "key permission",
  },
];

const SettingsTable: React.FC<{ rows: SettingRow[] }> = ({ rows }) => (
  <div className="divide-y divide-gray-100">
    {rows.map((row) => (
      <div key={row.name} className="py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800">{row.name}</code>
          <span className="text-xs text-gray-400">{row.fallback}</span>
        </div>
        <p className="mt-1 text-sm text-gray-600">{row.description}</p>
      </div>
    ))}
  </div>
);

interface AnonymizationSettingsProps {
  userRole: string | null;
}

const AnonymizationSettings: React.FC<AnonymizationSettingsProps> = ({ userRole }) => (
  <div className="flex flex-col gap-4">
    <Card>
      <CardHeader>
        <CardTitle>How to enable</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-gray-600">
        <p>
          The anonymizer runs as a guardrail. Add one on the Guardrails page with provider{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800">pii_anonymizer</code>, or
          declare it in config.yaml:
        </p>
        <pre className="overflow-x-auto rounded bg-gray-900 p-3 font-mono text-xs text-gray-100">
          {`guardrails:
  - guardrail_name: pii-anonymizer
    litellm_params:
      guardrail: pii_anonymizer
      mode: [pre_call, post_call]
      presidio_analyzer_api_base: http://presidio-analyzer:3000
      pii_ner_api_base: http://piiranha:8080
      pii_ner_stage_policy: on_miss
      pii_codec: placeholder
      pii_entities_config:
        CREDIT_CARD: BLOCK
        US_SSN: MASK
        PERSON: ENCODE`}
        </pre>
        <p>
          BLOCK rejects the request, MASK redacts irreversibly, and ENCODE replaces the value with a token that is
          restored in the response. Entities you do not list default to ENCODE.
        </p>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Detection</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsTable rows={DETECTION_SETTINGS} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Codec and keys</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsTable rows={CODEC_SETTINGS} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Token vault and retention</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          With the vault on, mappings are stored encrypted per scope with AES-256-GCM, bound to the row they belong to
          so a ciphertext moved to another scope fails to decrypt rather than silently resolving.
        </p>
        <SettingsTable rows={VAULT_SETTINGS} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Key permissions</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsTable rows={PERMISSIONS} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Standalone endpoints</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-gray-600">
        <p>
          The same logic is callable directly, which is what a browser extension or another integration would use. All
          three take a virtual key.
        </p>
        <SettingsTable
          rows={[
            {
              name: "POST /pii/detect",
              description: "Report what PII is present without altering the text.",
              fallback: "",
            },
            {
              name: "POST /pii/encode",
              description: "Replace PII with tokens and persist the mapping. Returns a session_id.",
              fallback: "",
            },
            {
              name: "POST /pii/decode",
              description:
                "Restore original values for tokens issued to this key. Requires permissions.allow_pii_decode on the key.",
              fallback: "",
            },
            {
              name: "GET /pii/session/{session_id}",
              description: "Token metadata for one session. Never returns a value or a ciphertext.",
              fallback: "vault only",
            },
            {
              name: "DELETE /pii/session/{session_id}",
              description: "Revoke everything one encode call minted, in one statement.",
              fallback: "vault only",
            },
            {
              name: "GET /pii/subject/{subject_id}",
              description:
                "Every value held for one subject. A bulk decode, so it needs allow_pii_decode and is audited.",
              fallback: "vault only",
            },
            {
              name: "DELETE /pii/subject/{subject_id}",
              description: "Erasure for one subject. Only finds what was tagged with a subject_id at encode time.",
              fallback: "vault only",
            },
            {
              name: "POST /pii/search",
              description:
                "Find which tokens decode to a value, by scanning the scope and comparing in memory. Requires allow_pii_search.",
              fallback: "vault only",
            },
          ]}
        />
        {userRole !== null && (
          <p className="text-xs text-gray-400">
            Signed in as {userRole}. Decode is scoped to the calling key, so a session_id alone never reads another
            key&apos;s tokens.
          </p>
        )}
      </CardContent>
    </Card>
  </div>
);

export default AnonymizationSettings;
