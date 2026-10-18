import {
  BadgeCheck,
  Ban,
  Bot,
  Boxes,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  ClipboardCheck,
  Clock,
  ClockAlert,
  Component,
  Container,
  Cpu,
  Database,
  Eye,
  FileCode,
  Forward,
  GitBranch,
  GitCommitHorizontal,
  Import,
  Lightbulb,
  ListChecks,
  ListTodo,
  type LucideIcon,
  MessageSquareQuote,
  Minus,
  OctagonAlert,
  Package,
  Plug,
  Quote,
  Scale,
  Shapes,
  ShieldAlert,
  Split,
  TriangleAlert,
  User,
  Wrench,
} from 'lucide-react'

const TYPE_ICONS: Record<string, LucideIcon> = {
  'software.System': Boxes,
  'software.Container': Container,
  'software.Component': Component,
  'software.Module': FileCode,
  'software.Endpoint': Plug,
  'software.DataEntity': Database,
  'software.Library': Package,
  'core.SourceSnapshot': GitCommitHorizontal,
  'core.Decision': Scale,
  'core.Alternative': Split,
  'core.Requirement': ListChecks,
  'core.Constraint': ShieldAlert,
  'core.Question': CircleQuestionMark,
  'core.Assertion': Quote,
  'core.Verification': BadgeCheck,
  'core.Task': ListTodo,
  'core.ExecutionReport': ClipboardCheck,
}

export function typeIcon(type: string): LucideIcon {
  return TYPE_ICONS[type] ?? Shapes
}

export const BASIS_ICONS: Record<string, LucideIcon> = {
  observed: Eye,
  inferred: Lightbulb,
  stated: MessageSquareQuote,
  imported: Import,
}

export const FRESHNESS_ICONS: Record<string, LucideIcon> = {
  current: CircleCheck,
  weakened: TriangleAlert,
  stale: OctagonAlert,
  'derived-stale': GitBranch,
  unknown: CircleDashed,
  'not-applicable': Minus,
}

export const PROPOSAL_ICONS: Record<string, LucideIcon> = {
  pending: Clock,
  committed: CircleCheck,
  rejected: Ban,
  invalid: CircleX,
  stale: ClockAlert,
  conflicting: TriangleAlert,
}

export const ORIGIN_ICONS: Record<string, LucideIcon> = {
  human: User,
  agent: Bot,
  model: Cpu,
  tool: Wrench,
  relayed: Forward,
}
