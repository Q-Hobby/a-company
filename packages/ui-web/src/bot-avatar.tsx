import type { GrokColorDef } from "@acompany/core";
import {
  ACTIVE_RUN_STATUSES,
  DEFAULT_GROK_BOT_COLOR,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
  shippedHash,
} from "@acompany/core";
import { memo, useId, useMemo } from "react";
import { cn } from "./lib/utils.js";
import "./styles.css";

export type { GrokColorDef };
export { DEFAULT_GROK_BOT_COLOR, GROK_BOT_COLORS, GROK_COLOR_LIST, resolvePersonaColorDef };

export const GROK_SHAPES = SHIPPED_BOT_AVATAR_SHAPES;
export const SHIPPED_SHAPE_KEYS = SHIPPED_BOT_AVATAR_SHAPE_KEYS;
const VIEWBOX = SHIPPED_BOT_AVATAR_VIEWBOX;
const CENTER = SHIPPED_BOT_AVATAR_CENTER;

export const GROK_MASCOT_SHAPES = SHIPPED_SHAPE_KEYS.map(
  (k) => GROK_SHAPES[k] ?? FALLBACK_SHAPE_PATH,
);

const FALLBACK_SHAPE_PATH = GROK_SHAPES.hex ?? "";

export function resolvePersonaShape(identity: string, explicitShape?: string | null): string {
  if (explicitShape) {
    const explicit = GROK_SHAPES[explicitShape];
    if (explicit) return explicit;
  }
  let hash = shippedHash(identity);
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  const shapeIndex = ((hash ^ (hash >>> 16)) >>> 0) % SHIPPED_SHAPE_KEYS.length;
  const key = SHIPPED_SHAPE_KEYS[shapeIndex] ?? "hex";
  return GROK_SHAPES[key] ?? FALLBACK_SHAPE_PATH;
}

export function resolvePersonaShapeIndex(identity: string, explicitShape?: string | null): number {
  if (explicitShape) {
    const idx = (SHIPPED_SHAPE_KEYS as readonly string[]).indexOf(explicitShape);
    if (idx >= 0) return idx;
  }
  let hash = shippedHash(identity);
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) % SHIPPED_SHAPE_KEYS.length;
}

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  // Only data: image URLs are rendered. Arbitrary http(s)/blob values in `color`
  // must not become <img src> (SSRF / tracking when other members view the bot).
  if (rawColor.startsWith("data:image/")) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const rawShapeIdx = parts[1] ?? "0";
    const parsedShapeIdx = /^\d+$/.test(rawShapeIdx) ? Number(rawShapeIdx) : 0;
    const shapeIdx = Number.isSafeInteger(parsedShapeIdx) ? parsedShapeIdx : 0;
    return {
      color: parts[0] || "#F97316",
      shapeIndex: shapeIdx % SHIPPED_SHAPE_KEYS.length,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
  variant?: unknown;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 36,
  status,
  identity = "",
  className,
}: BotAvatarProps) {
  const id = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const isWorking = ACTIVE_RUN_STATUSES.some((s) => s === status);

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  const shapeIndex = useMemo(() => {
    if (parsed.shapeIndex !== undefined) {
      return (
        ((Math.trunc(parsed.shapeIndex) % SHIPPED_SHAPE_KEYS.length) + SHIPPED_SHAPE_KEYS.length) %
        SHIPPED_SHAPE_KEYS.length
      );
    }
    return resolvePersonaShapeIndex(effectiveId);
  }, [parsed.shapeIndex, effectiveId]);

  const shapePath = useMemo(() => {
    return shippedBotAvatarShapePath(shapeIndex);
  }, [shapeIndex]);

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn(
          "acompany-bot-avatar relative overflow-hidden rounded-full flex items-center justify-center select-none bg-secondary shrink-0 border border-border",
          className,
        )}
        data-working={isWorking}
        style={{
          width: size,
          height: size,
          boxShadow: isWorking
            ? "0 0 0 2px #3B82F6, 0 0 10px rgba(59,130,246,0.6)"
            : "0 2px 5px rgba(0,0,0,0.5)",
        }}
      >
        {isWorking ? (
          <svg
            className="acompany-bot-avatar-ring absolute pointer-events-none"
            style={{
              inset: -4,
              width: size + 8,
              height: size + 8,
            }}
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="24"
              cy="24"
              r="22"
              stroke="#3B82F6"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeDasharray="45 80"
            />
          </svg>
        ) : null}
        <img src={parsed.imageUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "acompany-bot-avatar grok-avatar-container relative inline-flex items-center justify-center shrink-0 select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
      }}
      data-working={isWorking}
    >
      <svg
        className="acompany-bot-avatar-ring absolute pointer-events-none"
        style={{
          inset: -4,
          width: size + 8,
          height: size + 8,
          filter: `drop-shadow(0 0 6px ${colorDef.light}) drop-shadow(0 0 10px #ffffff)`,
        }}
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke={`url(#${id}-ring)`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
        <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
        <defs>
          <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="60%" stopColor={colorDef.light} stopOpacity="0.9" />
            <stop offset="100%" stopColor={colorDef.light} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <svg
        viewBox={VIEWBOX}
        width={size}
        height={size}
        aria-hidden="true"
        className={cn(
          "overflow-visible transition-transform duration-300",
          isWorking
            ? "animate-pulse scale-[1.04] motion-reduce:animate-none"
            : "hover:scale-[1.03] motion-reduce:hover:scale-100",
        )}
        style={{
          filter: isWorking
            ? `drop-shadow(0 0 8px ${colorDef.light}) drop-shadow(0 0 2px #ffffff)`
            : "drop-shadow(0 2px 4px rgba(0,0,0,0.45))",
        }}
      >
        <defs>
          <linearGradient id={`grok-ink-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colorDef.light} />
            <stop offset="100%" stopColor={colorDef.dark} />
          </linearGradient>
          <linearGradient id={`grok-gloss-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.25" />
          </linearGradient>
        </defs>
        <g>
          <path d={shapePath} fill={`url(#grok-ink-${id})`} />
          <path d={shapePath} fill={`url(#grok-gloss-${id})`} />
          <path d={shapePath} fill="none" stroke="rgba(255, 255, 255, 0.28)" strokeWidth="3" />
          <BotInsigniaGlyph shapeIndex={shapeIndex} />
        </g>
      </svg>
    </div>
  );
});

export function BotInsigniaGlyph({ shapeIndex }: { shapeIndex: number }) {
  const norm = ((Math.trunc(shapeIndex) % 8) + 8) % 8;
  const c = CENTER;
  switch (norm) {
    case 0:
      return (
        <g
          fill="none"
          stroke="#ffffff"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="grok-character-eyes"
        >
          <circle cx={c} cy={c} r={46} strokeWidth={2} strokeDasharray="4 4" opacity={0.4} />
          <polygon
            points={`${c},${c - 38} ${c + 33},${c - 19} ${c + 33},${c + 19} ${c},${c + 38} ${c - 33},${c + 19} ${c - 33},${c - 19}`}
            strokeWidth={3}
            opacity={0.85}
          />
          <polygon
            points={`${c},${c - 38} ${c + 33},${c + 19} ${c - 33},${c + 19}`}
            strokeWidth={2}
            opacity={0.5}
          />
          <polygon
            points={`${c},${c + 38} ${c + 33},${c - 19} ${c - 33},${c - 19}`}
            strokeWidth={2}
            opacity={0.5}
          />
          <ellipse cx={c} cy={c} rx={11} ry={11} fill="#ffffff" stroke="none" />
          <circle cx={c} cy={c} r={6} fill="#111318" stroke="none" />
        </g>
      );
    case 1:
      return (
        <g
          strokeLinecap="round"
          strokeLinejoin="round"
          transform="translate(0, 10)"
          className="grok-character-eyes"
        >
          <polygon
            points={`${c},${c - 32} ${c + 28},${c - 16} ${c},${c} ${c - 28},${c - 16}`}
            fill="#ffffff"
            opacity={0.95}
          />
          <polygon
            points={`${c - 28},${c - 16} ${c},${c} ${c},${c + 32} ${c - 28},${c + 16}`}
            fill="#ffffff"
            opacity={0.6}
          />
          <polygon
            points={`${c},${c} ${c + 28},${c - 16} ${c + 28},${c + 16} ${c},${c + 32}`}
            fill="#ffffff"
            opacity={0.8}
          />
          <line
            x1={c}
            y1={c - 32}
            x2={c}
            y2={c - 46}
            stroke="#ffffff"
            strokeWidth={3}
            opacity={0.9}
          />
          <line
            x1={c - 28}
            y1={c + 16}
            x2={c - 40}
            y2={c + 24}
            stroke="#ffffff"
            strokeWidth={3}
            opacity={0.9}
          />
          <line
            x1={c + 28}
            y1={c + 16}
            x2={c + 40}
            y2={c + 24}
            stroke="#ffffff"
            strokeWidth={3}
            opacity={0.9}
          />
          <ellipse cx={c} cy={c} rx={5} ry={5} fill="#111318" />
        </g>
      );
    case 2:
      return (
        <g
          fill="none"
          stroke="#ffffff"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="grok-character-eyes"
        >
          <circle cx={c} cy={c} r={45} strokeWidth={2.5} opacity={0.35} />
          <path
            d={`M ${c - 22} ${c - 38} L ${c + 18} ${c - 38} L ${c - 2} ${c - 12} Z`}
            fill="#ffffff"
            opacity={0.75}
          />
          <path
            d={`M ${c + 28} ${c - 28} L ${c + 42} ${c + 6} L ${c + 12} ${c + 4} Z`}
            fill="#ffffff"
            opacity={0.85}
          />
          <path
            d={`M ${c + 32} ${c + 18} L ${c + 12} ${c + 42} L ${c - 2} ${c + 18} Z`}
            fill="#ffffff"
            opacity={0.7}
          />
          <path
            d={`M ${c - 18} ${c + 38} L ${c - 38} ${c + 18} L ${c - 12} ${c + 8} Z`}
            fill="#ffffff"
            opacity={0.9}
          />
          <path
            d={`M ${c - 42} ${c - 4} L ${c - 28} ${c - 32} L ${c - 14} ${c - 8} Z`}
            fill="#ffffff"
            opacity={0.8}
          />
          <circle cx={c} cy={c} r={15} fill="#ffffff" opacity={0.95} />
          <ellipse cx={c - 4} cy={c - 4} rx={4} ry={2.5} fill="#111318" opacity={0.85} />
        </g>
      );
    case 3:
      return (
        <g fill="none" className="grok-character-eyes">
          <ellipse
            cx={c}
            cy={c}
            rx={50}
            ry={18}
            stroke="#ffffff"
            strokeWidth={2.5}
            opacity={0.45}
            transform={`rotate(-28 ${c} ${c})`}
          />
          <ellipse
            cx={c}
            cy={c}
            rx={50}
            ry={18}
            stroke="#ffffff"
            strokeWidth={2}
            strokeDasharray="6 4"
            opacity={0.35}
            transform={`rotate(35 ${c} ${c})`}
          />
          <path
            d={`M ${c} ${c - 44} Q ${c} ${c} ${c + 44} ${c} Q ${c} ${c} ${c} ${c + 44} Q ${c} ${c} ${c - 44} ${c} Q ${c} ${c} ${c} ${c - 44} Z`}
            fill="#ffffff"
          />
          <ellipse cx={c} cy={c} rx={9} ry={9} fill="#111318" />
          <ellipse cx={c} cy={c} rx={5} ry={5} fill="#ffffff" />
          <circle cx={c - 32} cy={c - 26} r={3.5} fill="#ffffff" opacity={0.9} />
          <circle cx={c + 32} cy={c + 26} r={3.5} fill="#ffffff" opacity={0.9} />
        </g>
      );
    case 4:
      return (
        <g fill="none" stroke="#ffffff" className="grok-character-eyes">
          <ellipse cx={c} cy={c} rx={45} ry={16} strokeWidth={3} opacity={0.75} />
          <ellipse
            cx={c}
            cy={c}
            rx={45}
            ry={16}
            strokeWidth={3}
            opacity={0.75}
            transform={`rotate(60 ${c} ${c})`}
          />
          <ellipse
            cx={c}
            cy={c}
            rx={45}
            ry={16}
            strokeWidth={3}
            opacity={0.75}
            transform={`rotate(120 ${c} ${c})`}
          />
          <ellipse cx={c} cy={c} rx={12} ry={12} fill="#ffffff" stroke="none" />
          <circle cx={c} cy={c} r={6} fill="#111318" stroke="none" />
          <circle cx={c + 38} cy={c} r={3.5} fill="#ffffff" stroke="none" />
          <circle cx={c - 19} cy={c + 33} r={3.5} fill="#ffffff" stroke="none" />
          <circle cx={c - 19} cy={c - 33} r={3.5} fill="#ffffff" stroke="none" />
        </g>
      );
    case 5:
      return (
        <g fill="none" strokeLinecap="round" className="grok-character-eyes">
          <path
            d={`M ${c - 28} ${c} C ${c - 28} ${c - 22}, ${c - 10} ${c - 22}, ${c} ${c} C ${c + 10} ${c + 22}, ${c + 28} ${c + 22}, ${c + 28} ${c} C ${c + 28} ${c - 22}, ${c + 10} ${c - 22}, ${c} ${c} C ${c - 10} ${c + 22}, ${c - 28} ${c + 22}, ${c - 28} ${c} Z`}
            stroke="#ffffff"
            strokeWidth={7}
          />
          <path
            d={`M ${c - 28} ${c} C ${c - 28} ${c - 22}, ${c - 10} ${c - 22}, ${c} ${c} C ${c + 10} ${c + 22}, ${c + 28} ${c + 22}, ${c + 28} ${c} C ${c + 28} ${c - 22}, ${c + 10} ${c - 22}, ${c} ${c} C ${c - 10} ${c + 22}, ${c - 28} ${c + 22}, ${c - 28} ${c} Z`}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={13}
            opacity={0.3}
          />
          <ellipse cx={c - 18} cy={c} rx={5} ry={5} fill="#ffffff" />
          <ellipse cx={c + 18} cy={c} rx={5} ry={5} fill="#ffffff" />
          <circle cx={c} cy={c} r={4} fill="#ffffff" />
        </g>
      );
    case 6:
      return (
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform="translate(0, 5)"
          className="grok-character-eyes"
        >
          <path
            d={`M ${c} ${c - 45} Q ${c + 30} ${c - 10} ${c + 24} ${c + 20} Q ${c + 16} ${c + 42} ${c} ${c + 42} Q ${c - 16} ${c + 42} ${c - 24} ${c + 20} Q ${c - 30} ${c - 10} ${c} ${c - 45} Z`}
            stroke="#ffffff"
            strokeWidth={3}
            opacity={0.5}
          />
          <path
            d={`M ${c} ${c - 28} Q ${c + 18} ${c - 4} ${c + 14} ${c + 16} Q ${c + 8} ${c + 28} ${c} ${c + 28} Q ${c - 8} ${c + 28} ${c - 14} ${c + 16} Q ${c - 18} ${c - 4} ${c} ${c - 28} Z`}
            fill="#ffffff"
            opacity={0.95}
          />
          <ellipse cx={c} cy={c + 12} rx={6} ry={8} fill="#111318" />
        </g>
      );
    case 7:
    default:
      return (
        <g stroke="#ffffff" strokeLinecap="round" className="grok-character-eyes">
          <line x1={c} y1={c} x2={c - 30} y2={c - 18} strokeWidth={2.5} opacity={0.5} />
          <line x1={c} y1={c} x2={c + 30} y2={c - 18} strokeWidth={2.5} opacity={0.5} />
          <line x1={c} y1={c} x2={c - 25} y2={c + 25} strokeWidth={2.5} opacity={0.5} />
          <line x1={c} y1={c} x2={c + 25} y2={c + 25} strokeWidth={2.5} opacity={0.5} />
          <line
            x1={c - 30}
            y1={c - 18}
            x2={c + 30}
            y2={c - 18}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            opacity={0.4}
          />
          <line
            x1={c - 25}
            y1={c + 25}
            x2={c + 25}
            y2={c + 25}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            opacity={0.4}
          />
          <ellipse cx={c} cy={c} rx={14} ry={14} fill="#ffffff" stroke="none" />
          <circle cx={c} cy={c} r={7} fill="#111318" stroke="none" />
          <circle cx={c - 30} cy={c - 18} r={6} fill="#ffffff" stroke="none" />
          <circle cx={c + 30} cy={c - 18} r={6} fill="#ffffff" stroke="none" />
          <circle cx={c - 25} cy={c + 25} r={6} fill="#ffffff" stroke="none" />
          <circle cx={c + 25} cy={c + 25} r={6} fill="#ffffff" stroke="none" />
        </g>
      );
  }
}

export function GrokShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const key = SHIPPED_SHAPE_KEYS[shapeIndex % SHIPPED_SHAPE_KEYS.length] ?? "hex";
  const path = shippedBotAvatarShapePath(shapeIndex);
  const colorDef = resolvePersonaColorDef("preview", color);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={key}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      <svg viewBox={VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id={`preview-gloss-${shapeIndex}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.25" />
          </linearGradient>
        </defs>
        <path d={path} fill={colorDef.light} />
        <path d={path} fill={`url(#preview-gloss-${shapeIndex})`} />
        <path d={path} fill="none" stroke="rgba(255, 255, 255, 0.28)" strokeWidth="3" />
        <BotInsigniaGlyph shapeIndex={shapeIndex} />
      </svg>
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        A-Company
      </span>
    </div>
  );
}
