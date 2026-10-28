/** Host-facing copy for the settings slot; the card body itself is zh-first. */

export interface HoneyGuardSettingsKey {
  tabLabel: string
  tabsLabel: string
  cardTitle: string
}

export const zh: Record<keyof HoneyGuardSettingsKey, string> = {
  tabLabel: 'Honey Guard',
  tabsLabel: 'Honey Guard',
  cardTitle: '脱敏日志',
}

export const en: Record<keyof HoneyGuardSettingsKey, string> = {
  tabLabel: 'Honey Guard',
  tabsLabel: 'Honey Guard',
  cardTitle: 'Substitution log',
}
