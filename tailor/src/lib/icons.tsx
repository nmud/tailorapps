import {
  Bookmark,
  BookOpen,
  Braces,
  CalendarDays,
  ChartLine,
  ClipboardList,
  FileText,
  FolderKanban,
  GitBranch,
  GraduationCap,
  Highlighter,
  Inbox,
  Layers,
  Library,
  Link2,
  ListChecks,
  Microscope,
  Network,
  NotebookPen,
  Quote,
  Repeat,
  Search,
  Table2,
  Target,
  Terminal,
  Timer,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { AccentName } from './types';

export const APP_ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  network: Network,
  table: Table2,
  timer: Timer,
  'list-checks': ListChecks,
  'notebook-pen': NotebookPen,
  search: Search,
  layers: Layers,
  calendar: CalendarDays,
  'chart-line': ChartLine,
  link: Link2,
  'git-branch': GitBranch,
  terminal: Terminal,
  kanban: FolderKanban,
  'graduation-cap': GraduationCap,
  clipboard: ClipboardList,
  'file-text': FileText,
  bookmark: Bookmark,
  repeat: Repeat,
  quote: Quote,
  highlighter: Highlighter,
  inbox: Inbox,
  target: Target,
  workflow: Workflow,
  library: Library,
  microscope: Microscope,
  braces: Braces,
};

export const ICON_NAMES = Object.keys(APP_ICONS);
export const ACCENTS: AccentName[] = ['moss', 'ink', 'clay', 'tide', 'plum', 'ochre'];

export function AppGlyph({ icon, accent, size = 'md' }: { icon: string; accent: AccentName; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = APP_ICONS[icon] ?? Layers;
  return (
    <span className={`glyph glyph--${size}`} data-accent={accent} aria-hidden="true">
      <Icon strokeWidth={1.75} />
    </span>
  );
}
