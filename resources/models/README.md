# Bundled models

`magic_touch.tflite` is MediaPipe's Magic Touch interactive segmenter (Apache License 2.0), from
`https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`
(SHA-256 `e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`). The object selection tool runs it in the page when you click an object.

Select Subject's model, ISNet (Apache License 2.0, about 170 MB), is not bundled: the app downloads it on first use and checks it against the SHA-256 in `src/shared/segmentation.ts`.
