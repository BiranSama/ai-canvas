import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { sceneElementSchema, type SceneElement } from '../../src/domain'
import { makeImage, makeText } from './scene-fixtures'

// Deterministic, original offline artwork fixtures. These are authored graphics,
// never evidence of real model quality or online product identity retention.
export const COMPLETION_SIZE = { width: 1200, height: 1500 }
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">${body}</svg>`
export async function completionLandscape(variant = 0): Promise<Buffer> {
  const warm = variant === 1
  return sharp(Buffer.from(svg(`<defs>
    <linearGradient id="paper" x2="0" y2="1"><stop stop-color="${warm ? '#eee7d7' : '#e9ede5'}"/><stop offset="1" stop-color="#c6d4cd"/></linearGradient>
    <linearGradient id="far" x2="0" y2="1"><stop stop-color="#799797"/><stop offset="1" stop-color="#a9c1b9"/></linearGradient>
    <linearGradient id="near" x2=".6" y2="1"><stop stop-color="#314f57"/><stop offset="1" stop-color="#73958c"/></linearGradient>
    <linearGradient id="sea" x2="0" y2="1"><stop stop-color="#a7c0b8"/><stop offset="1" stop-color="#dce1d5"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="20"/></filter>
  </defs>
  <rect width="1200" height="1500" fill="url(#paper)"/>
  <circle cx="${warm ? 880 : 930}" cy="${warm ? 355 : 395}" r="67" fill="${warm ? '#d5ad76' : '#d7c397'}" opacity=".85"/>
  <path d="M-80 1040 115 895 222 918 413 720 522 809 689 683 782 781 912 732 1290 987V1500H-80Z" fill="url(#far)"/>
  <path d="M-60 1110 145 1011 237 847 364 959 480 901 575 1001 797 850 939 991 1050 969 1240 1100V1500H-60Z" fill="#648a8a" opacity=".77"/>
  <path d="M-80 1250 101 1115 246 1138 407 917 527 1066 697 1001 845 1134 999 1052 1230 1170V1500H-80Z" fill="url(#near)"/>
  <path d="M-40 1220C238 1115 293 1284 479 1237S742 1140 924 1212 1138 1238 1240 1216V1500H-40Z" fill="url(#sea)"/>
  <ellipse cx="760" cy="1130" rx="530" ry="47" fill="#ecede2" opacity=".32" filter="url(#soft)"/>
  ${Array.from({ length: 19 }, (_, i) => `<path d="M${40 + i * 11} ${1258 + i * 10}Q600 ${1230 + i * 13} ${1150 - i * 19} ${1250 + i * 11}" fill="none" stroke="#eff0e5" stroke-opacity="${.17 + i % 3 * .06}" stroke-width="${i % 4 === 0 ? 2 : 1}"/>`).join('')}
  <path d="M847 1125q18 -16 38 0m-23 -2q16 -15 30 -1" fill="none" stroke="#344e54" stroke-width="2" opacity=".55"/>
  <path d="M95 93H1105M95 1410H1105" stroke="#526967" stroke-opacity=".32"/>
  <rect x="99" y="126" width="5" height="95" fill="#aa6556"/>
  <rect x="1082" y="1327" width="22" height="47" fill="#a66557" opacity=".8"/>
  `))).png().toBuffer()
}

export async function completionProduct(variant = 0, objectOnly = false): Promise<Buffer> {
  const environment = `<defs><linearGradient id="room" x2=".85" y2="1"><stop stop-color="${variant === 1 ? '#e7d7bc' : '#d9e2dc'}"/><stop offset=".6" stop-color="#f3eee2"/><stop offset="1" stop-color="#aab7aa"/></linearGradient><radialGradient id="light"><stop stop-color="#fffdf3" stop-opacity=".9"/><stop offset="1" stop-color="#fffdf3" stop-opacity="0"/></radialGradient><linearGradient id="stone" x2=".7" y2="1"><stop stop-color="#e4dbcc"/><stop offset="1" stop-color="#b6b3a5"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="24"/></filter></defs>
    <rect width="1200" height="1500" fill="url(#room)"/><ellipse cx="300" cy="450" rx="750" ry="720" fill="url(#light)"/>
    <path d="M960 0 420 1500H620L1160 0Z" fill="#fffef7" opacity=".18"/>
    <path d="M0 980Q350 955 1200 1040V1500H0Z" fill="#c7c9bc" opacity=".38"/>
    <ellipse cx="646" cy="1270" rx="340" ry="51" fill="#546556" opacity=".2" filter="url(#blur)"/>
    <path d="M285 1120 866 1090 940 1270 258 1280Z" fill="url(#stone)"/><path d="M285 1120 866 1090 895 1130 265 1160Z" fill="#eee7d9"/>
    <path d="M269 1234 464 1210 567 1230 912 1198M309 1179 430 1170 508 1188M724 1255 870 1242" stroke="#969b8c" stroke-opacity=".3" fill="none"/>
    <path d="M115 1015Q144 864 236 733M150 926Q69 883 76 822Q146 834 150 926M177 849Q154 756 202 716Q229 784 177 849" fill="#667f6b" opacity=".35"/>
    <path d="M100 1360H1100" stroke="#6f7b68" stroke-opacity=".35"/>`
  const bottle = `<defs><linearGradient id="glass" x2="1" y2=".35"><stop stop-color="#93a995" stop-opacity=".7"/><stop offset=".1" stop-color="#fbfcde" stop-opacity=".73"/><stop offset=".45" stop-color="#afbe93" stop-opacity=".54"/><stop offset=".87" stop-color="#ebedb9" stop-opacity=".75"/><stop offset="1" stop-color="#728c76" stop-opacity=".85"/></linearGradient><linearGradient id="cap" x2="1"><stop stop-color="#292f29"/><stop offset=".32" stop-color="#53584b"/><stop offset=".57" stop-color="#73786a"/><stop offset="1" stop-color="#29372f"/></linearGradient></defs>
    <rect x="433" y="545" width="333" height="583" rx="48" fill="url(#glass)" stroke="#728b73" stroke-opacity=".65" stroke-width="3"/>
    <rect x="449" y="567" width="301" height="539" rx="36" fill="none" stroke="#faffde" stroke-width="7" opacity=".56"/>
    <path d="M460 922H739V1074Q737 1099 710 1099H488Q462 1099 460 1073Z" fill="#b1b971" opacity=".29"/>
    <rect x="542" y="507" width="116" height="43" rx="10" fill="#718875"/><rect x="516" y="406" width="168" height="119" rx="13" fill="url(#cap)"/>
    <path d="M531 416V508M544 416V508M557 416V508M650 416V508M664 416V508" stroke="#d0d1b3" stroke-opacity=".17" stroke-width="2"/>
    <rect x="471" y="714" width="256" height="244" fill="#f4f0e3" stroke="#d5d6bd" stroke-width="2"/>
    <text x="600" y="773" text-anchor="middle" font-family="Georgia,serif" font-size="27" letter-spacing="6" fill="#52644f">AUREL</text>
    <path d="M508 797H691" stroke="#acb097"/><text x="600" y="853" text-anchor="middle" font-family="Georgia,serif" font-size="37" fill="#405b45">MIST</text>
    <text x="600" y="906" text-anchor="middle" font-family="Georgia,serif" font-size="14" letter-spacing="2" fill="#6d775f">EAU DE PARFUM · 50 ML</text>
    <path d="M463 610V694M462 975V1057M736 625V696" stroke="#fffde7" stroke-width="8" stroke-linecap="round" opacity=".72"/>`
  return sharp(Buffer.from(svg(`${objectOnly ? '' : environment}${bottle}`))).png().toBuffer()
}

export function completionImage(assetId: string, name: string, zIndex = 0): SceneElement {
  return sceneElementSchema.parse({ ...makeImage(), id: randomUUID(), assetId, name, zIndex,
    referenceRole: 'composition', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, fit: 'fill' })
}
export function completionTypography(kind: 'cover' | 'product'): SceneElement[] {
  const title = kind === 'cover' ? '山海之间' : '晨雾'
  return [
    { name: '准确主标题', content: title, x: .095, y: .19, w: .76, h: .09, size: kind === 'cover' ? 91 : 96, weight: 400, color: '#304a49', spacing: 9, align: 'left', family: 'Microsoft YaHei' },
    { name: '英文副题', content: kind === 'cover' ? 'BETWEEN MOUNTAIN & SEA' : 'AUREL  /  MORNING MIST', x: .1, y: .305, w: .78, h: .04, size: 19, weight: 400, color: '#647873', spacing: 3.6, align: 'left', family: 'Segoe UI' },
    { name: '系列', content: kind === 'cover' ? '山海叙事  ·  01' : '植物气息  ·  木质留香', x: .1, y: .073, w: .78, h: .038, size: 18, weight: 400, color: '#596e65', spacing: 2, align: 'right', family: 'Microsoft YaHei' },
    { name: '准确页脚', content: kind === 'cover' ? '在山的远处，听见海。' : '晨雾系列  /  淡香精  /  50 mL', x: .1, y: .949, w: .79, h: .029, size: 18, weight: 400, color: '#52685e', spacing: 2, align: 'left', family: 'Microsoft YaHei' }
  ].map((line, index) => sceneElementSchema.parse({ ...makeText(index + 2), id: randomUUID(), name: line.name, content: line.content,
    transform: { x: line.x, y: line.y, width: line.w, height: line.h, rotation: 0 }, fontFamily: line.family, fontSize: line.size,
    fontWeight: line.weight, fill: line.color, letterSpacing: line.spacing, align: line.align === 'left' ? 'start' : 'end', styleDescription: '准确可编辑排版，保持留白', visualWeight: index === 0 ? 'hero' : 'secondary' }))
}
