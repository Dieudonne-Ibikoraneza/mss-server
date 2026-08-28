import { IsObject } from 'class-validator';

/**
 * A partial patch of the settings map: `{ "platform.name": "…", "notifications.lowStockAlerts": false }`.
 * Unknown keys are rejected by the service against the SETTINGS_DEFAULTS allow-list.
 */
export class UpdateSettingsDto {
  @IsObject()
  settings: Record<string, unknown>;
}
