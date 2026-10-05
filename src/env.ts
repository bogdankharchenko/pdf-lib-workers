export interface Env {
  PDF_BUCKET: R2Bucket;
  API_KEY?: string;
  SIGNING_KEY?: string;
  SIGNED_URL_TTL?: string;
  MAX_FETCH_BYTES?: string;
}
