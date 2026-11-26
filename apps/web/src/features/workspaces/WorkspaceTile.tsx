// A workspace's letter tile (frame 004): the current workspace in --fg like the sidebar button, the
// others on a label hue picked from the slug, so each keeps its colour in every list.
import { cn, labelColor, projectHue } from '~/ui';

export interface WorkspaceTileProps {
  name: string;
  slug: string;
  /** The workspace the page is in: drawn like the sidebar's workspace button. */
  current?: boolean;
  /** 22 (the switcher) or 18 (the palette). */
  size?: 22 | 18;
  className?: string;
}

export function WorkspaceTile({ name, slug, current = false, size = 22, className }: WorkspaceTileProps) {
  const letter = name.trim().charAt(0).toUpperCase() || 'W';
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-sm font-bold',
        size === 22 ? 'size-5.5 text-xs' : 'size-4.5',
        current ? 'bg-fg text-bg' : 'text-tile-ink',
        className,
      )}
      // The letter follows the tile on the small size, like ProjectTile.
      style={{
        ...(current ? {} : { background: labelColor(projectHue(slug)) }),
        ...(size === 18 ? { fontSize: 10, lineHeight: 1 } : {}),
      }}
    >
      {letter}
    </span>
  );
}
