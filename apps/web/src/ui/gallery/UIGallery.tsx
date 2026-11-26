import { WorkspacesGallery } from '~/features/workspaces/WorkspacesGallery';
import { M5Gallery } from './M5Gallery';
import { M6Gallery } from './M6Gallery';
import { M7Gallery } from './M7Gallery';
import { TokensSheet } from './TokensSheet';

/**
 * /__ui: the M5 Margin kit (frames 001 and 002, light and dark, then the pickers and dialogs), the M6 work
 * record pieces (light and dark), the M7 pull-request, archive and check-again pieces (light and dark), the
 * workspace screens (switcher, New workspace, General, /welcome;
 * light and dark), then the tokens sheet (colours, type scale, radii, elevation, spacing) with the kit
 * components on them.
 */
export function UIGallery() {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <M5Gallery />
      <M6Gallery />
      <M7Gallery />
      <WorkspacesGallery />
      <div className="border-t border-line">
        <TokensSheet />
      </div>
    </div>
  );
}
