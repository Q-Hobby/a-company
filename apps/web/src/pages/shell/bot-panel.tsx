import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  StarterTeamSummary,
  ThinkingLevel,
  VoiceInfo,
} from "@acompany/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
} from "@acompany/contracts";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@acompany/ui-web";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { AvatarStudioPopover } from "./avatar-studio-popover";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
);

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";

function ComputerModePicker({
  value,
  onChange,
  teamTestId,
  privateTestId,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
  teamTestId?: string;
  privateTestId?: string;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Computer</Trans>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            pressed={value === mode}
            data-testid={mode === "team" ? teamTestId : privateTestId}
            onPressedChange={(pressed) => {
              if (pressed) onChange(mode);
            }}
            className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

function buildConnectedOptions(
  credentials: ModelCredential[],
  catalog: ModelCatalogEntry[],
): Array<{
  credentialId: string;
  key: string;
  provider: string;
  modelId: string;
  label: string;
}> {
  const connectedOptions: Array<{
    credentialId: string;
    key: string;
    provider: string;
    modelId: string;
    label: string;
  }> = [];
  const seenOptions = new Set<string>();
  const providerCounts = new Map<string, number>();
  for (const credential of credentials) {
    providerCounts.set(credential.provider, (providerCounts.get(credential.provider) ?? 0) + 1);
  }
  for (const credential of credentials) {
    const multipleConnections = (providerCounts.get(credential.provider) ?? 0) > 1;
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const credentialInCatalog = Boolean(
      credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
    );
    const options =
      credential.modelId && !credentialInCatalog
        ? [
            {
              key: modelOptionKey(
                multipleConnections ? credential.id : null,
                credential.provider,
                credential.modelId,
              ),
              credentialId: credential.id,
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(
              multipleConnections ? credential.id : null,
              entry.provider,
              entry.id,
            ),
            credentialId: credential.id,
            provider: entry.provider,
            modelId: entry.id,
            label: `${credential.label} · ${entry.label}`,
          }));
    for (const option of options) {
      if (seenOptions.has(option.key)) continue;
      seenOptions.add(option.key);
      connectedOptions.push(option);
    }
  }
  return connectedOptions;
}

export function CreateBotForm({
  onCreate,
  onCancel,
  onImportedBots,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
    modelProvider?: string | null;
    modelCredentialId?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onCancel: () => void;
  onImportedBots?: (botIds: string[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const mdUploadRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [starters, setStarters] = useState<StarterTeamSummary[]>([]);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      rpc.models.credentials(),
      rpc.models.list(),
      rpc.me(),
      rpc.blueprints.listStarters().catch(() => [] as StarterTeamSummary[]),
    ])
      .then(([nextCredentials, nextCatalog, nextMe, nextStarters]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setMe(nextMe);
        setStarters(nextStarters);
      })
      .catch(() => undefined);
  }, []);

  const connectedOptions = buildConnectedOptions(credentials, catalog);
  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = modelKey
    ? (() => {
        const parsed = parseModelOptionKey(modelKey);
        if (!parsed) return undefined;
        if (parsed.credentialId) {
          return credentials.find((entry) => entry.id === parsed.credentialId);
        }
        return (
          credentials.find(
            (entry) => entry.provider === parsed.provider && entry.modelId === parsed.modelId,
          ) ?? credentials.find((entry) => entry.provider === parsed.provider)
        );
      })()
    : credentials.find(
        (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
      );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = effectiveCredential?.thinkingLevel ?? "medium";

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    const selected = modelKey ? parseModelOptionKey(modelKey) : null;
    const resolvedCredentialId =
      selected?.credentialId ??
      connectedOptions.find((option) => option.key === modelKey)?.credentialId ??
      null;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
        modelProvider: selected?.provider ?? null,
        modelCredentialId: resolvedCredentialId,
        modelId: selected?.modelId ?? null,
        thinkingLevel: thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="create-bot-form">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New bot</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Cancel new bot`} onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="create-bot-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Describe what this bot does`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={4}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
        <Trans>Model</Trans>
        <NativeSelect
          id={`${ids}-model`}
          className="mt-2 w-full"
          value={modelKey}
          onChange={(event) => {
            setModelKey(event.target.value);
            setThinkingLevel("");
          }}
        >
          <NativeSelectOption value="">
            {t`Space default`}
            {me?.defaultModel
              ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
              : ""}
          </NativeSelectOption>
          {connectedOptions.map((option) => (
            <NativeSelectOption key={option.key} value={option.key}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {thinkingOptions.length ? (
        <label htmlFor={`${ids}-thinking`} className={fieldLabelClass}>
          <Trans>Thinking</Trans>
          <NativeSelect
            id={`${ids}-thinking`}
            className="mt-2 w-full"
            value={thinkingLevel}
            onChange={(event) => setThinkingLevel(event.target.value)}
          >
            <NativeSelectOption value="">
              {t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`}
            </NativeSelectOption>
            {thinkingOptions.map((level) => (
              <NativeSelectOption key={level} value={level}>
                {thinkingLevelLabel(level)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      <div data-testid="create-bot-computer">
        <ComputerModePicker
          value={computerMode}
          onChange={setComputerMode}
          teamTestId="create-bot-team"
          privateTestId="create-bot-private"
        />
      </div>
      <Button
        className="mt-5"
        disabled={!name.trim() || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
      </Button>
      {onImportedBots ? (
        <div className="mt-6 border-t border-border/40 pt-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-muted-foreground">
              <Trans>Or start from a template</Trans>
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={submitting}
              onClick={() => mdUploadRef.current?.click()}
            >
              <Trans>Import .md</Trans>
            </Button>
            <input
              ref={mdUploadRef}
              type="file"
              className="hidden"
              accept=".md,text/markdown,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setSubmitting(true);
                setError(null);
                void file
                  .text()
                  .then((markdown) => rpc.blueprints.importMarkdown({ markdown }))
                  .then((res) => onImportedBots(res.botIds))
                  .catch((err) =>
                    setError(err instanceof Error ? err.message : t`Invalid blueprint Markdown`),
                  )
                  .finally(() => setSubmitting(false));
              }}
            />
          </div>
          {starters.length > 0 ? (
            <div className="space-y-1.5">
              {starters.map((starter) => (
                <button
                  key={starter.slug}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setSubmitting(true);
                    setError(null);
                    void rpc.blueprints
                      .applyStarter({ slug: starter.slug })
                      .then((res) => onImportedBots(res.botIds))
                      .catch((err) =>
                        setError(
                          err instanceof Error ? err.message : t`Could not add starter team`,
                        ),
                      )
                      .finally(() => setSubmitting(false));
                  }}
                  className="w-full rounded-lg border border-border px-3 py-2 text-start transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between text-[13px] font-medium text-foreground">
                    <span>{starter.label}</span>
                    <span className="text-[11.5px] text-muted-foreground">+{starter.botCount}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {starter.description}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function BotSettings({
  bot,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
}: {
  bot: Bot;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    notifyOnFinish?: boolean;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelCredentialId?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [color, setColor] = useState(bot.color);
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelCredentialId && bot.modelProvider && bot.modelId
      ? modelOptionKey(bot.modelCredentialId, bot.modelProvider, bot.modelId)
      : bot.modelProvider && bot.modelId
        ? `${bot.modelProvider}::${bot.modelId}`
        : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (patchOverrides?: {
      name?: string;
      title?: string;
      description?: string;
      color?: string;
      notifyOnFinish?: boolean;
    }) => Promise<void>
  >(async () => undefined);
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
    void Promise.all([rpc.models.credentials(), rpc.models.list(), rpc.me()])
      .then(([nextCredentials, nextCatalog, nextMe]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setMe(nextMe);
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch(() => undefined);
  }, []);

  const connectedOptions = buildConnectedOptions(credentials, catalog);
  const resolvedModelKey =
    modelKey && !connectedOptions.some((option) => option.key === modelKey)
      ? (() => {
          const parsed = parseModelOptionKey(modelKey);
          if (!parsed?.credentialId) return modelKey;
          const legacyKey = `${parsed.provider}::${parsed.modelId}`;
          return connectedOptions.some((option) => option.key === legacyKey) ? legacyKey : modelKey;
        })()
      : modelKey;

  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = modelKey
    ? (() => {
        const parsed = parseModelOptionKey(modelKey);
        if (!parsed) return undefined;
        if (parsed.credentialId) {
          return credentials.find((entry) => entry.id === parsed.credentialId);
        }
        return (
          credentials.find(
            (entry) => entry.provider === parsed.provider && entry.modelId === parsed.modelId,
          ) ?? credentials.find((entry) => entry.provider === parsed.provider)
        );
      })()
    : credentials.find(
        (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
      );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = effectiveCredential?.thinkingLevel ?? "medium";

  async function executeSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
    modelKey?: string;
    thinkingLevel?: string;
  }) {
    const nextModelKey =
      patchOverrides?.modelKey !== undefined ? patchOverrides.modelKey : modelKey;
    const nextThinkingLevel =
      patchOverrides?.thinkingLevel !== undefined ? patchOverrides.thinkingLevel : thinkingLevel;
    const selected = nextModelKey ? parseModelOptionKey(nextModelKey) : null;
    const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
    const nextTitle = (patchOverrides?.title !== undefined ? patchOverrides.title : title).trim();
    const nextDescription = (
      patchOverrides?.description !== undefined ? patchOverrides.description : description
    ).trim();
    const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
    const nextNotify =
      patchOverrides?.notifyOnFinish !== undefined ? patchOverrides.notifyOnFinish : notifyOnFinish;

    if (nextName) setName(nextName);
    setTitle(nextTitle);
    setDescription(nextDescription);

    try {
      setSaving(true);
      setError(null);
      await onSave({
        name: nextName || bot.name,
        title: nextTitle,
        description: nextDescription,
        instructions: nextDescription,
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== bot.color ? { color: nextColor } : {}),
        notifyOnFinish: nextNotify,
        computerMode,
        memoryScope,
        autoSpeak,
        voiceId: voiceId || null,
        modelProvider: selected?.provider ?? null,
        modelCredentialId:
          selected?.credentialId ??
          connectedOptions.find((option) => option.key === nextModelKey)?.credentialId ??
          null,
        modelId: selected?.modelId ?? null,
        ...(modelMetaReady
          ? {
              thinkingLevel: thinkingOptions.length
                ? ((nextThinkingLevel || null) as ThinkingLevel | null)
                : null,
            }
          : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
    } finally {
      setSaving(false);
    }
  }
  executeSaveRef.current = executeSave;

  function enqueueSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
    modelKey?: string;
    thinkingLevel?: string;
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => executeSaveRef.current(patchOverrides));
    return saveQueueRef.current;
  }

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center py-4">
        <AvatarStudioPopover
          value={color}
          identity={bot.id}
          status={bot.status}
          size={76}
          onChange={(newColor) => {
            setColor(newColor);
            void enqueueSave({ color: newColor });
          }}
        />
      </div>
      <label htmlFor={`${ids}-name`} className="mt-4 block text-[13.5px] text-muted-foreground/80">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void enqueueSave()}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void enqueueSave()}
          placeholder={t`e.g. Hivenet Agent, Presales, Timesheets bot`}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void enqueueSave()}
          rows={3}
          className="mt-1.5"
        />
      </label>
      <div className="mt-6 flex items-center justify-between pt-4 border-t border-border/20">
        <div className="space-y-0.5 pe-4">
          <div
            id={`${ids}-notify-finish-label`}
            className="text-[13.5px] font-medium text-foreground"
          >
            <Trans>Notifications</Trans>
          </div>
          <div id={`${ids}-notify-finish-desc`} className="text-[12px] text-muted-foreground/70">
            <Trans>Get notified when this Bot finishes or needs input</Trans>
          </div>
        </div>
        <Switch
          id={`${ids}-notify-finish`}
          checked={notifyOnFinish}
          aria-labelledby={`${ids}-notify-finish-label`}
          aria-describedby={`${ids}-notify-finish-desc`}
          onCheckedChange={(checked) => {
            setNotifyOnFinish(checked);
            void enqueueSave({ notifyOnFinish: checked });
          }}
        />
      </div>
      <details
        data-testid="bot-settings-advanced"
        className="group mt-5"
        onToggle={(event) => {
          if (event.currentTarget.open) setAdvancedOpened(true);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <span className="text-muted-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
          <Trans>Model</Trans>
          <NativeSelect
            id={`${ids}-model`}
            className="mt-2 w-full"
            value={resolvedModelKey}
            onChange={(event) => {
              const nextKey = event.target.value;
              setModelKey(nextKey);
              setThinkingLevel("");
              void enqueueSave({ modelKey: nextKey, thinkingLevel: "" });
            }}
          >
            <NativeSelectOption value="">
              {t`Space default`}
              {me?.defaultModel
                ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
                : ""}
            </NativeSelectOption>
            {resolvedModelKey &&
            !connectedOptions.some((option) => option.key === resolvedModelKey) ? (
              <NativeSelectOption value={resolvedModelKey}>
                {parseModelOptionKey(resolvedModelKey)?.modelId ?? resolvedModelKey}
              </NativeSelectOption>
            ) : null}
            {connectedOptions.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {thinkingOptions.length ? (
          <label htmlFor={`${ids}-thinking`} className={fieldLabelClass}>
            <Trans>Thinking</Trans>
            <NativeSelect
              id={`${ids}-thinking`}
              className="mt-2 w-full"
              value={thinkingLevel}
              onChange={(event) => {
                const nextLevel = event.target.value;
                setThinkingLevel(nextLevel);
                void enqueueSave({ thinkingLevel: nextLevel });
              }}
            >
              <NativeSelectOption value="">
                {t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`}
              </NativeSelectOption>
              {thinkingOptions.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
          {advancedOpened ? (
            <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
          ) : null}
        </Suspense>
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-muted-foreground">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
                ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
              ).map((option) => (
                <Toggle
                  key={option.label}
                  variant="outline"
                  size="sm"
                  pressed={memoryScope === option.value}
                  onPressedChange={(pressed) => {
                    if (pressed) setMemoryScope(option.value);
                  }}
                  className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
        ) : null}
        <label
          htmlFor={`${ids}-auto-speak`}
          className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-foreground/75"
        >
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label htmlFor={`${ids}-voice`} className={fieldLabelClass}>
            <Trans>Voice</Trans>
            <NativeSelect
              id={`${ids}-voice`}
              className="mt-2 w-full"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        <BotWebhookSection botId={bot.id} initialConfigured={Boolean(bot.webhookConfigured)} />
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            void enqueueSave({
              name,
              title,
              description,
              color,
              notifyOnFinish,
            });
          }}
        >
          <Trans>Save</Trans>
        </Button>
        <Button variant="ghost" size="sm" className="-ms-2.5" onClick={() => void onExport()}>
          <Trans>Export</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 text-destructive hover:text-destructive"
          onClick={onClear}
        >
          <Trans>Clear conversation</Trans>
        </Button>
      </div>
    </div>
  );
}

function modelOptionKey(credentialId: string | null, provider: string, modelId: string) {
  return credentialId ? `${credentialId}::${provider}::${modelId}` : `${provider}::${modelId}`;
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") return t`Extra high`;
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  if (level === "minimal") return t`Minimal`;
  if (level === "max") return t`Max`;
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function parseModelOptionKey(key: string) {
  const parts = key.split("::");
  // Legacy keys carry only provider::modelId (no pinned connection).
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { credentialId: null, provider: parts[0], modelId: parts[1] };
  }
  const [credentialId, provider, ...rest] = parts;
  const modelId = rest.join("::");
  if (!credentialId || !provider || !modelId) return null;
  return { credentialId, provider, modelId };
}

function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

function BotWebhookSection({
  botId,
  initialConfigured,
}: {
  botId: string;
  initialConfigured: boolean;
}) {
  const [configured, setConfigured] = useState(initialConfigured);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3100";
  const endpointUrl = `${origin}/api/v1/bots/${encodeURIComponent(botId)}/webhook`;

  async function rotate() {
    setRotating(true);
    setCopied(false);
    try {
      const res = await rpc.bots.rotateWebhookSecret({ botId });
      setSecret(res.secret);
      setConfigured(true);
    } finally {
      setRotating(false);
    }
  }

  function copyCurl() {
    if (!secret) return;
    const cmd = `curl -X POST "${endpointUrl}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"event":"ping"}'`;
    void navigator.clipboard?.writeText(cmd).then(() => setCopied(true));
  }

  return (
    <div
      data-testid="bot-webhook-section"
      className="mt-5 space-y-2 border-t border-border/30 pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13.5px] font-medium text-foreground">
          <Trans>Inbound Webhook</Trans>
        </span>
        <Button size="xs" variant="outline" disabled={rotating} onClick={() => void rotate()}>
          {configured ? <Trans>Rotate secret</Trans> : <Trans>Enable webhook</Trans>}
        </Button>
      </div>
      <div className="break-all rounded bg-muted/60 px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
        POST {endpointUrl}
      </div>
      {secret ? (
        <div className="space-y-1.5">
          <div className="break-all rounded bg-muted px-2.5 py-1.5 font-mono text-[11.5px] text-foreground">
            Bearer {secret}
          </div>
          <Button size="xs" variant="ghost" onClick={copyCurl}>
            {copied ? <Trans>Copied curl</Trans> : <Trans>Copy curl example</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
