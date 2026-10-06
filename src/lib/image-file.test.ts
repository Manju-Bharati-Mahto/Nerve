import { describe, expect, it } from 'vitest'
import { checkImageFile, HEIC_MESSAGE, IMAGE_ACCEPT, IMAGE_TYPE_MESSAGE, sizeLabel } from './image-file'
import { boCheckPhotos } from './brandops-api'

const MB = 1024 * 1024
const file = (name: string, type: string, size = 10) => ({ name, type, size })

describe('checkImageFile', () => {
  it('accepts the raster types the server accepts, JPEG aliases included', () => {
    for (const t of ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(checkImageFile(file('a', t), MB), t).toBeNull()
    }
  })

  it('refuses HEIC by type or by name, before anything else', () => {
    expect(checkImageFile(file('IMG_1.HEIC', 'image/heic'), MB)).toBe(HEIC_MESSAGE)
    expect(checkImageFile(file('x', 'image/heif-sequence'), MB)).toBe(HEIC_MESSAGE)
    expect(checkImageFile(file('IMG_2.heic', 'application/octet-stream'), MB)).toBe(HEIC_MESSAGE)
    expect(checkImageFile(file('IMG_3.heif', '', 50 * MB), MB)).toBe(HEIC_MESSAGE)
  })

  it('refuses SVG, an untyped file and anything else', () => {
    expect(checkImageFile(file('a.svg', 'image/svg+xml'), MB)).toBe(IMAGE_TYPE_MESSAGE)
    expect(checkImageFile(file('a.jpg', ''), MB)).toBe(IMAGE_TYPE_MESSAGE)
    expect(checkImageFile(file('a.jpg', 'text/html'), MB)).toBe(IMAGE_TYPE_MESSAGE)
  })

  it('refuses a file over the limit, naming the limit', () => {
    expect(checkImageFile(file('a.png', 'image/png', 3 * MB + 1), 3 * MB)).toBe('That image is larger than 3 MB.')
    expect(checkImageFile(file('a.png', 'image/png', 3 * MB), 3 * MB)).toBeNull()
  })

  it('lists only types the server accepts in IMAGE_ACCEPT', () => {
    for (const t of IMAGE_ACCEPT.split(',')) expect(checkImageFile(file('a', t), MB)).toBeNull()
  })

  it('labels sizes as a person reads them', () => {
    expect(sizeLabel(10 * MB)).toBe('10 MB')
    expect(sizeLabel(1.5 * MB)).toBe('1.5 MB')
    expect(sizeLabel(512 * 1024)).toBe('512 KB')
  })
})

describe('boCheckPhotos', () => {
  it('names the photo that is wrong, using the shared rule', () => {
    expect(boCheckPhotos([file('ok.jpg', 'image/jpeg'), file('IMG.HEIC', 'image/heic')] as unknown as File[]))
      .toBe(`IMG.HEIC: ${HEIC_MESSAGE}`)
    expect(boCheckPhotos([file('big.png', 'image/png', 11 * MB)] as unknown as File[]))
      .toBe('big.png: That image is larger than 10 MB.')
    expect(boCheckPhotos([file('ok.jpg', 'image/jpeg')] as unknown as File[])).toBeNull()
    expect(boCheckPhotos(null)).toBeNull()
  })

  it('refuses more than ten at a time', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => file(`${i}.jpg`, 'image/jpeg')) as unknown as File[]
    expect(boCheckPhotos(eleven)).toBe('Choose at most 10 photos at a time — 11 are selected.')
  })
})
