# Kalorien – Offline-Kalorientracker fürs iPhone

Web-App (PWA): Kalorien, Makros und Mahlzeiten tracken, Lebensmittel per EAN-Barcode scannen.
Alles läuft offline, alle Daten bleiben auf dem iPhone.

- 324.000 Produkte aus Deutschland, Österreich und der Schweiz (Open Food Facts, Lizenz ODbL)
- Barcode-Scanner über die Kamera (ZXing, offline)
- Frühstück / Mittag / Abend / Snacks, Tagesziele für kcal, Eiweiß, Kohlenhydrate, Fett
- Eigene Lebensmittel, Schnelleintrag, Verlauf, Backup als JSON

## Auf das iPhone bringen

Die Dateien müssen einmal über **https** erreichbar sein (sonst erlaubt iOS keine Kamera).
Kostenlos geht das z. B. mit GitHub Pages:

1. Auf github.com ein kostenloses Konto anlegen.
2. Neues Repository anlegen (öffentlich), z. B. `kalorien`.
3. "uploading an existing file" wählen und **den Inhalt** dieses Ordners hochladen (alle Dateien und Ordner, nicht den Ordner selbst).
4. Im Repository: Settings → Pages → Branch `main` / `(root)` → Save.
5. Nach 1–2 Minuten ist die App unter `https://<name>.github.io/kalorien/` erreichbar.
6. Auf dem iPhone in **Safari** öffnen → Teilen-Symbol → **Zum Home-Bildschirm**.
7. App vom Home-Bildschirm starten. Beim ersten Start lädt sie die Datenbank (ca. 11 MB, 1–2 Minuten).

Danach braucht die App kein Internet mehr. Auf der Webseite liegen nur die App und die
Lebensmitteldatenbank, keine persönlichen Daten.

## Wichtig

- Deine Daten liegen nur in der App auf dem iPhone. Löschst du die App vom Home-Bildschirm,
  sind sie weg. Deshalb ab und zu unter Einstellungen → **Backup exportieren** sichern.
- Die App immer vom Home-Bildschirm starten, nicht in Safari (das ist ein getrennter Speicher).

## Datenbank aktualisieren (optional)

```bash
curl -sL https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz \
  | gunzip | python3 tools/build_food_db.py data/foods.tsv.gz
```

Danach in `app.js` `DB_FILE_VERSION` und in `sw.js` `CACHE` hochzählen und neu hochladen.
