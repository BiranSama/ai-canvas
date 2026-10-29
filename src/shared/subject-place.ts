/*
 * Which placeholders are a subject's place: a picture generated for one is
 * cut out of its background when it is placed, so the image model is asked
 * for the subject alone. A placeholder that keeps its background, a
 * landscape, or one that fills most of the canvas is a scene, placed as it
 * comes.
 */

/** A placeholder this share of the canvas is a background. */
export const BACKGROUND_SHARE = 0.8

export interface SubjectPlace {
  /** The placeholder's transparentBackground: its picture is cut out of its background. */
  readonly cutout: boolean
  readonly visualKind?: string | undefined
  readonly transform: { readonly width: number; readonly height: number }
}

/** Whether a picture placed here is fitted at all: cut out or feathered, and toned to its surroundings. */
export function fitsIntoPlace(place: SubjectPlace): boolean {
  return place.cutout && place.transform.width * place.transform.height < BACKGROUND_SHARE
}

/** Whether the image model is asked for the subject alone on a plain background. */
export function asksForLoneSubject(place: SubjectPlace): boolean {
  return fitsIntoPlace(place) && place.visualKind !== 'landscape'
}
