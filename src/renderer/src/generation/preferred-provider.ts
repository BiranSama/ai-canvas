import type { GenerationProfileSnapshot } from '../../../shared/generation'
import type { ProviderSettingsSnapshot } from '../../../shared/provider-settings'

const OPERATION_WORDS = { generate: '生图', reference: '参考图生成', edit: '局部修改' } as const

/**
 * The image service an action uses: the default one when real calls are
 * allowed and it can do the operation; otherwise the first other set-up
 * service that can, with a note saying so; otherwise the local mock, which
 * needs no confirmation and costs nothing.
 */
export function chooseImageProvider(
  operation: 'generate' | 'reference' | 'edit',
  settings: ProviderSettingsSnapshot,
  profiles: GenerationProfileSnapshot
): {
  readonly providerId: string
  readonly model: string
  readonly profileId: string
  readonly confirmed: boolean
  /** Set when a service other than the default does this, or none can. */
  readonly note: string | null
} {
  const images = settings.providers.filter((provider) => provider.kind === 'image')
  const usable = (id: string) => {
    const service = images.find((provider) => provider.id === id)
    const profile = profiles.profiles.find((entry) => entry.status === 'available'
      && entry.profile.providerId === id
      && entry.profile.supportedOperations.includes(operation))?.profile
    return settings.realCallsAuthorized && service?.configured === true && service.baseUrl.trim() !== '' && service.defaultModel.trim() !== '' && profile !== undefined
      ? { service, profile }
      : null
  }
  const preferred = usable(settings.defaultImageProviderId)
  const chosen = preferred ?? images.map((provider) => usable(provider.id)).find((candidate) => candidate !== null) ?? null
  const fallbackDefault = images.find((provider) => provider.id === settings.defaultImageProviderId)
  if (chosen === null) {
    const configured = images.some((provider) => provider.configured)
    return {
      providerId: 'mock', model: 'mock-balanced', profileId: 'local-sketch', confirmed: false,
      note: configured ? `设置里的生图服务都不能做${OPERATION_WORDS[operation]}，这次用本地草图。` : null
    }
  }
  return {
    providerId: chosen.service.id,
    model: chosen.service.defaultModel,
    profileId: chosen.profile.id,
    confirmed: true,
    note: preferred === null ? `默认的${fallbackDefault?.label ?? '生图服务'}不能做${OPERATION_WORDS[operation]}，这次用${chosen.service.label}。` : null
  }
}

export async function preferredImageProvider(operation: 'generate' | 'reference' | 'edit'): Promise<ReturnType<typeof chooseImageProvider>> {
  const [settings, profiles] = await Promise.all([
    window.desktop.getProviderSettings(),
    window.desktop.listGenerationProfiles()
  ])
  return chooseImageProvider(operation, settings, profiles)
}
