import type { AvatarStyle, UsageBudget } from "@acompany/contracts";
import { BotAvatar, Button, Input, Toggle } from "@acompany/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { ComputersUnavailableHint } from "../components/ComputersUnavailableHint";
import { DesktopUpdateSection } from "../components/DesktopUpdates";
import { SoftwareUpdateSection } from "../components/SoftwareUpdateSection";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import {
  type AppearancePreference,
  getUiAppearancePreference,
  setUiAppearance,
} from "../lib/ui-appearance";
import { UI_LOCALE_LABELS, UI_LOCALES, type UiLocale } from "../lib/ui-locale";

export type SettingsGeneralProps = {
  email?: string | null;
  name?: string;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  isDeploymentOwner?: boolean;
};

export function GeneralSettingsPanels({
  avatarStyle,
  onAvatarStyleChange,
  messagingEnabled = false,
  onOpenMessaging,
  isDeploymentOwner = false,
}: SettingsGeneralProps) {
  const { t } = useLingui();
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++localeRequestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== localeRequestRef.current) return;
      setLocale(activated);
    });
  }

  async function chooseAvatarStyle(next: AvatarStyle) {
    if (avatarPending || next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await onAvatarStyleChange(next);
    } catch {
      setAvatarError(t`Couldn't update avatars`);
    } finally {
      setAvatarPending(false);
    }
  }

  return (
    <div className="space-y-5">
      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <p className="mt-3 text-[13px] text-muted-foreground/70">
            <Trans>Chat apps, group channels, and agent connections.</Trans>
          </p>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Appearance</Trans>
        </h3>
        <AppearancePicker
          value={appearance}
          onChange={(next) => {
            setAppearance(next);
            setUiAppearance(next);
          }}
        />
      </section>

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Language</Trans>
        </h3>
        <UiLocalePicker value={locale} onChange={chooseLocale} />
      </section>

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Avatars</Trans>
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(["robot", "organic"] as const).map((style) => (
            <Toggle
              key={style}
              variant="outline"
              pressed={style === avatarStyle}
              disabled={avatarPending}
              onPressedChange={() => void chooseAvatarStyle(style)}
              className="h-auto justify-start gap-3 px-3.5 py-3 text-[14px] font-normal"
            >
              <BotAvatar
                color="#D9508A"
                identity="avatar-style-preview"
                size={32}
                variant={style}
              />
              <span>{style === "robot" ? <Trans>Robot</Trans> : <Trans>Organic</Trans>}</span>
            </Toggle>
          ))}
        </div>
        {avatarError ? (
          <p role="alert" className="mt-3 text-[12.5px] text-destructive">
            {avatarError}
          </p>
        ) : null}
      </section>

      {isDeploymentOwner ? (
        <Button variant="outline" render={<Link to="/integrations/setup" />}>
          <Trans>Server integrations</Trans>
        </Button>
      ) : null}

      <details data-testid="advanced-settings" className="group rounded-xl border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
          <span>
            <span className="block text-[15px] text-foreground">
              <Trans>Advanced</Trans>
            </span>
            <span className="mt-1 block text-[12.5px] text-muted-foreground/80">
              <Trans>Optional controls most people never need</Trans>
            </span>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-5">
          <ApprovalRulesSettings />
        </div>
      </details>
    </div>
  );
}

export function UsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLingui();
  const capIds = useId();
  const [budget, setBudget] = useState<UsageBudget | null>(null);
  const [dailyCapInput, setDailyCapInput] = useState("");
  const [monthlyCapInput, setMonthlyCapInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void rpc.usage
      .budget()
      .then((res) => {
        if (!active) return;
        setBudget(res);
        setDailyCapInput(res.dailyTokenCap ? String(res.dailyTokenCap) : "");
        setMonthlyCapInput(res.monthlyTokenCap ? String(res.monthlyTokenCap) : "");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function saveCaps() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const parseCap = (raw: string): number | null => {
        const cleaned = raw.replace(/[,_\s]/g, "").trim();
        if (!cleaned) return null;
        const num = Number(cleaned);
        if (!Number.isInteger(num) || num < 1000) {
          throw new Error(t`Caps must be whole numbers of at least 1,000 tokens (or empty).`);
        }
        return num;
      };
      const dailyTokenCap = parseCap(dailyCapInput);
      const monthlyTokenCap = parseCap(monthlyCapInput);
      const updated = await rpc.usage.updateBudget({ dailyTokenCap, monthlyTokenCap });
      setBudget((prev) =>
        prev
          ? {
              ...prev,
              dailyTokenCap: updated.dailyTokenCap,
              monthlyTokenCap: updated.monthlyTokenCap,
              todayTokens: updated.todayTokens,
              monthTokens: updated.monthTokens,
            }
          : updated,
      );
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Failed to save spend caps.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="space-y-4 outline-none"
    >
      <div className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Usage</Trans>
        </h3>
        {usage ? (
          <p className="mt-3 text-[14px] text-foreground/75">
            <Trans>
              {usage.runs} runs · {(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens
            </Trans>
          </p>
        ) : null}
        {budget ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]">
              <div className="text-muted-foreground">
                <Trans>Today (UTC)</Trans>
              </div>
              <div className="mt-0.5 font-medium text-foreground">
                {budget.todayTokens.toLocaleString()}
                {budget.dailyTokenCap ? ` / ${budget.dailyTokenCap.toLocaleString()}` : ""} tokens
              </div>
            </div>
            <div className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]">
              <div className="text-muted-foreground">
                <Trans>This month (UTC)</Trans>
              </div>
              <div className="mt-0.5 font-medium text-foreground">
                {budget.monthTokens.toLocaleString()}
                {budget.monthlyTokenCap ? ` / ${budget.monthlyTokenCap.toLocaleString()}` : ""}{" "}
                tokens
              </div>
            </div>
          </div>
        ) : null}
        <p className={`text-[12.5px] text-muted-foreground/80 ${usage ? "mt-3" : "mt-3"}`}>
          <Trans>Model spend uses your provider keys or local CLI sessions.</Trans>
        </p>
      </div>

      <div
        data-testid="usage-spend-caps"
        className="rounded-xl border border-border px-4 py-4 space-y-3"
      >
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Token spend caps</Trans>
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={`${capIds}-daily`} className="block text-[13px] text-muted-foreground">
            <Trans>Daily token cap</Trans>
            <Input
              id={`${capIds}-daily`}
              value={dailyCapInput}
              onChange={(e) => {
                setDailyCapInput(e.target.value);
                setSaved(false);
              }}
              placeholder={t`Unlimited`}
              inputMode="numeric"
              className="mt-1.5"
            />
          </label>
          <label htmlFor={`${capIds}-monthly`} className="block text-[13px] text-muted-foreground">
            <Trans>Monthly token cap</Trans>
            <Input
              id={`${capIds}-monthly`}
              value={monthlyCapInput}
              onChange={(e) => {
                setMonthlyCapInput(e.target.value);
                setSaved(false);
              }}
              placeholder={t`Unlimited`}
              inputMode="numeric"
              className="mt-1.5"
            />
          </label>
        </div>
        {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={saving} onClick={() => void saveCaps()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save caps</Trans>}
          </Button>
          {saved ? (
            <span className="text-[12.5px] text-muted-foreground">
              <Trans>Saved</Trans>
            </span>
          ) : null}
        </div>
      </div>

      {budget && budget.byBot.length > 0 ? (
        <div className="rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>By Bot</Trans>
          </h3>
          <div className="mt-3 divide-y divide-border text-[13px]">
            {budget.byBot.map((row) => (
              <div
                key={row.botId ?? "system"}
                className="flex items-center justify-between py-2 gap-3"
              >
                <span className="truncate font-medium text-foreground">{row.botName}</span>
                <span className="shrink-0 text-muted-foreground">
                  {row.runs} runs · {(row.inputTokens + row.outputTokens).toLocaleString()} tokens
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {budget && budget.byModel.length > 0 ? (
        <div className="rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>By Model</Trans>
          </h3>
          <div className="mt-3 divide-y divide-border text-[13px]">
            {budget.byModel.map((row) => (
              <div
                key={`${row.provider}:${row.model}`}
                className="flex items-center justify-between py-2 gap-3"
              >
                <span className="truncate font-medium text-foreground">
                  {row.provider} / {row.model}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {row.runs} runs · {(row.inputTokens + row.outputTokens).toLocaleString()} tokens
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ComputerSettingsPanel() {
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Computers</Trans>
      </h3>
      <ComputersUnavailableHint className="mt-3 text-[13px] leading-relaxed text-muted-foreground" />
    </div>
  );
}

export function UpdatesSettingsPanel({
  isDeploymentOwner = false,
}: {
  isDeploymentOwner?: boolean;
}) {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
      <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />
    </div>
  );
}

function AppearancePicker({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
}) {
  const { t } = useLingui();
  const options: { value: AppearancePreference; label: string }[] = [
    { value: "system", label: t`System` },
    { value: "light", label: t`Light` },
    { value: "dark", label: t`Dark` },
  ];

  return (
    <fieldset
      aria-label={t`Appearance`}
      data-testid="ui-appearance-select"
      className="mt-3 grid min-w-0 grid-cols-3 gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          data-testid={`ui-appearance-${option.value}`}
          pressed={option.value === value}
          onPressedChange={() => onChange(option.value)}
          className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </Toggle>
      ))}
    </fieldset>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, UI_LOCALES.indexOf(value));
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.focus();
  }, [highlightedIndex, open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const next = UI_LOCALES[index];
    if (!next) return;
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    setHighlightedIndex((index + UI_LOCALES.length) % UI_LOCALES.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(UI_LOCALES.length - 1);
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(UI_LOCALES.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative mt-3">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        data-testid="ui-locale-select"
        aria-label={t`Language`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{UI_LOCALE_LABELS[value]}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t`Language`}
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-1 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {UI_LOCALES.map((code, index) => (
            <button
              key={code}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={code === value}
              tabIndex={index === highlightedIndex ? 0 : -1}
              className={`w-full rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent focus-visible:bg-accent ${
                code === value ? "bg-accent" : ""
              }`}
              onClick={() => choose(index)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              {UI_LOCALE_LABELS[code]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
