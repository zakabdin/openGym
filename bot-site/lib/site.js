export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://opengym.one').replace(/\/$/, '')
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.opengym.one').replace(/\/$/, '')
export const BOT = process.env.NEXT_PUBLIC_BOT_USERNAME || 'lift_track_bot'
export const BOT_URL = `https://t.me/${BOT}`
export const REPO_URL = 'https://github.com/DuarteSantos8/openGym'
export const NAME = 'openGym Bot'

// Exercise pictures are fetched from the public dataset the app itself uses; nothing is redistributed here.
export const IMG_BASE = process.env.NEXT_PUBLIC_IMG_BASE || 'https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/'
