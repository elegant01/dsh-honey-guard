/**
 * Browser half: the substitution log on the plugin's settings card.
 *
 * The rc.2 host mounts plugin config panes on `plugins.bundle.config` (keyed
 * by bundle package name). That slot is declared by the host at runtime — the
 * published slots types don't carry it — so we augment SlotMap ourselves to
 * make the types match the real slot.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { HoneyGuardCard } from './HoneyGuardCard.tsx'
import { en, zh, type HoneyGuardSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.honey-guard': HoneyGuardSettingsKey
  }
  interface SlotMap {
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

export const name = 'dsh-honey-guard-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.honey-guard'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'honey-guard: settings copy')

    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register(
        {
          name: 'plugins.bundle.config',
          key: 'dsh-honey-guard',
          locale: namespace,
        },
        () => <HoneyGuardCard />,
      ),
    )
  } catch (error: unknown) {
    // A card that fails to load must never take the host settings page down.
    console.error('[dsh-honey-guard] client card failed to load (guard unaffected):', error)
  }
}
