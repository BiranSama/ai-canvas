import { showAppNotice } from '../components/app-notice'

/** Photoshop's Select Subject; the local models arrive with the segmentation runtime. */
export async function selectSubject(): Promise<void> {
  showAppNotice('选择主体需要本地模型，还没有装好。')
}
