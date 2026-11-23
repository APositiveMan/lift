# Lift: your personal training & diet app

## 1. Put it online for free (GitHub Pages, ~5 min)
1. Create a GitHub account if you don't have one, then create a new repository, e.g. `lift`.
   Make it **Public**, because free GitHub Pages needs a public repo. That's fine: the repo only holds the code, and your workouts and diet data stay on your phone.
2. Click **Add file → Upload files**, drag in everything from this folder (including the `icons` folder), and commit.
3. Go to **Settings → Pages**. Under "Build and deployment", pick **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After about a minute your app is live at `https://<your-username>.github.io/lift/`.

## 2. Install it on your iPhone
1. Open that link in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. From now on, always open Lift from the Home Screen icon. Data saved in the installed app is kept separately from Safari's, and iOS doesn't auto-clear it.

## 3. Turn on the AI (free)
1. Go to https://aistudio.google.com/apikey, sign in with Google and click **Create API key**.
2. In Lift, open **Settings**, choose **Google Gemini (free tier)**, paste the key and tap **Test connection**.
   The key is stored only on your phone. On Google's free tier, prompts may be used to improve Google's products, so don't type anything private into the coach.
   If Google ever retires the default model, enter a current one (e.g. a newer "flash" model) in the **Model** field.

## 4. Updating the app later
Replace the changed files in the GitHub repo. Also open `sw.js` and bump `VERSION` (e.g. `lift-v2`).
Close and reopen the app (sometimes twice) to get the new version. Your data isn't touched.

## Backups
Settings has **Export backup**, which saves a `.json` file to Files/iCloud. Do this every now and then.
**Import backup** restores it, for example on a new phone.
