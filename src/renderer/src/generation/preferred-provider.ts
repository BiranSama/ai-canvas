/**
 * The image service an action uses: the default one, with its default
 * model, when real calls are allowed and it is set up for the operation;
 * otherwise the local mock, which needs no confirmation and costs nothing.
 */
export async function preferredImageProvider(operation: 'generate' | 'reference' | 'edit'): Promise<{
  readonly providerId: string
  readonly model: string
  readonly profileId: string
  readonly confirmed: boolean
}> {
  const [settings, profiles] = await Promise.all([
    window.desktop.getProviderSettings(),
    window.desktop.listGenerationProfiles()
  ])
  const imageProvider = settings.providers.find((provider) => provider.id === settings.defaultImageProviderId)
  const realProfile = profiles.profiles.find((entry) => entry.status === 'available'
    && entry.profile.providerId === settings.defaultImageProviderId
    && entry.profile.supportedOperations.includes(operation))?.profile
  return settings.realCallsAuthorized
    && imageProvider?.configured === true
    && imageProvider.baseUrl.trim() !== ''
    && imageProvider.defaultModel.trim() !== ''
    && realProfile !== undefined
    ? { providerId: imageProvider.id, model: imageProvider.defaultModel, profileId: realProfile.id, confirmed: true }
    : { providerId: 'mock', model: 'mock-balanced', profileId: 'local-sketch', confirmed: false }
}
