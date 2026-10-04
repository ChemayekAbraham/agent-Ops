# Flutter Export — Android Google Sign-In Configuration

## SHA-256 Certificate Fingerprints

The following fingerprints must be added to your **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Android)** under "Restricted usage > SHA-1 / SHA-256 certificate fingerprints".

| Build Type | SHA-256 Fingerprint |
|------------|---------------------|
| APK        | `76081105A9CA38A0D539903FEFE2CFC200FC0851DCDABD591E6AD65DD631B01C` |
| AAB        | `96ECA7798276D2E3278CF7F7B99479CC44468404394ACD174212DEBF68A8E4DD` |

## Where to add them

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your Welile project
3. Navigate to **APIs & Services → Credentials**
4. Find your **OAuth 2.0 Client ID** for Android
5. Click **Edit**
6. Under **Restricted usage**, add both SHA-256 fingerprints above
7. Save

## Environment Variables

These values are also stored in the project `.env` file:
- `WELILE_ANDROID_APK_SHA256`
- `WELILE_ANDROID_AAB_SHA256`

## Notes

- If you are using **Lovable Cloud managed Google OAuth**, you may need to switch to **Bring Your Own OAuth (BYOK)** for Android app authentication, as managed credentials typically only support web redirect URIs.
- Ensure your Android package name in the Google Cloud Console matches the `applicationId` in your Flutter `android/app/build.gradle`.
