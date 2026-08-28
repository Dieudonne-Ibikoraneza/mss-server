import { HearAboutUs } from '@prisma/client';

export interface DiscoverySourceOption {
  value: HearAboutUs;
  label: string;
}

/**
 * The canonical "how did you hear about us?" options (doc section 3.1: "social
 * media, referral, advertisement, search engine, other"). The frontend pulls
 * this list instead of hardcoding its own copy, so the two never drift —
 * whatever value it submits back in `RegisterDto.heardAboutUs` is guaranteed
 * to already be valid.
 */
export const DISCOVERY_SOURCES: DiscoverySourceOption[] = [
  { value: HearAboutUs.SOCIAL_MEDIA, label: 'Social Media' },
  { value: HearAboutUs.REFERRAL, label: 'Referral' },
  { value: HearAboutUs.ADVERTISEMENT, label: 'Advertisement' },
  { value: HearAboutUs.SEARCH_ENGINE, label: 'Search Engine' },
  { value: HearAboutUs.OTHER, label: 'Other' },
];
