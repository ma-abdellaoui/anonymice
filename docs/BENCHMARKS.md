<div align="center">

<img src="assets/anonymice-logo.png" alt="Anonymice" width="280">

# Erkennungsqualität: Messungen am Swiss-Data-Airlock-Korpus

</div>

---

Alle Zahlen in diesem Dokument stammen aus Läufen gegen den **laufenden Stack**
(Proxy, Presidio, NER-Container), nicht aus Unit-Tests und nicht aus Schätzungen.
Jede Tabelle nennt, wie sie entstanden ist, und der Abschnitt
[Grenzen der Messung](#grenzen-der-messung) sagt, was sie *nicht* belegt. Wir halten
das für wichtiger als eine hohe Zahl: eine Erkennungsrate ohne Methodenkritik ist
für eine Datenschutzkomponente wertlos.

## Korpus

`swiss-data-airlock-testdata` — synthetische Testdaten der Natron-Challenge,
CC0, Seed `20260822`, deterministisch reproduzierbar über den mitgelieferten
`generate.py`.

| | |
|---|---|
| Dokumente | 49 (Ticket, Wiki, E-Mail, Meeting, Chat, Notification) |
| Sprache | überwiegend Deutsch (Schweizer Schreibweise), einzelne englische Dokumente |
| Stammdaten | 60 Kunden, 94 Ansprechpersonen, 8 interne Konten |
| Länge | 432 bis 13'168 Zeichen |
| Bewertete PII-Vorkommen | 330 |

Der Korpus enthält absichtlich schwierige Fälle: Schreibvarianten derselben Person
(`Hans Müller`, `H. Müller`, `Müller, Hans`), gleiche Nachnamen bei verschiedenen
Personen, ein Nachname der zugleich Ortsname ist, sowie **öffentliche Angaben, die
nicht maskiert werden dürfen** (Hotline, Rechnungsadresse, Bürostandort) und
**funktionale Felder, deren Ersetzung den Zieldienst bricht**.

## Methode

Für jedes Dokument ist die zugehörige Kundennummer bekannt. Die Sollwerte werden
deshalb aus `customers.csv` und `staff.csv` **abgeleitet**, nicht von Hand annotiert:
alle Feldwerte des verknüpften Kunden plus alle internen Konten werden im Volltext
gesucht, jedes Vorkommen ist ein Sollwert.

Gewertet wird **Überlappung**, nicht Etikettengleichheit: ein Sollwert gilt als
erkannt, wenn ihn irgendein erkannter Span berührt. Das ist die sicherheitsrelevante
Frage — wurde der Wert überhaupt ersetzt — und nicht, ob das Label perfekt war. Wo
labelgenau gemessen wurde, steht es dabei.

Reproduktion: siehe [Messungen wiederholen](#messungen-wiederholen).

## Ergebnis 1 — Erkennung pro Entität

Voller Stack, alle 49 Dokumente, NER-Stufe gefenstert auf 2000 Zeichen, Sprache `de`.

| Entität | Vorkommen | Piiranha (aktuell) | openai/privacy-filter |
|---|---:|---:|---:|
| **PERSON** | 189 | **43.4 %** | **88.4 %** |
| EMAIL_ADDRESS | 75 | 100 % | 100 % |
| PHONE_NUMBER | 30 | 100 % | 100 % |
| LOCATION | 14 | 100 % | 78.6 % |
| CUSTOMER_NO | 12 | 0 % | 16.7 % |
| CONTRACT_NO | 8 | 0 % | 50.0 % |
| AHV | 1 | 100 % | 100 % |
| DATE_TIME | 1 | 100 % | 100 % |
| **Gesamt** | **330** | **61.5 %** | **88.2 %** |

Muster statt Modell wird zuverlässig gefunden: E-Mail, Telefon und IBAN liegen bei
100 %, weil sie aus der regelbasierten Stufe kommen und sprachunabhängig sind.
**Namen sind die Lücke.**

## Ergebnis 2 — Namen, labelgenau

Nur Spans mit Typ `PERSON`, 189 Vorkommen. Die entscheidende Messung.

| Detektor | erkannt | Anteil |
|---|---:|---:|
| Piiranha (aktuell ausgeliefert) | 81 | 42.9 % |
| Presidio spaCy `de_core_news_md` | 163 | **86.2 %** |
| openai/privacy-filter | 164 | **86.8 %** |
| privacy-filter + Presidio | 179 | 94.7 % |
| alle drei | 185 | **97.9 %** |

Zwei Befunde, die die Architekturdiskussion tragen:

1. **Kein einzelnes Modell kommt über ~87 %.** Die beiden starken Detektoren sind
   einzeln fast gleichauf, verfehlen aber *unterschiedliche* Namen — zusammen
   gewinnen sie acht Prozentpunkte. Das ist das quantitative Argument für eine
   mehrstufige Erkennung statt eines besseren Einzelmodells.

2. **Presidio erkennt Namen bereits heute**, im selben Container, der ohnehin läuft.
   Stufe 1 fragt bewusst nur Muster-Entitäten ab und verwirft die NER-Ergebnisse.
   Diese Entscheidung kostet 43 Prozentpunkte Namenserkennung.

## Ergebnis 3 — Laufzeit und Ressourcen

Gemessen auf Apple Silicon, CPU, ohne GPU. 49 Dokumente.

| | Piiranha | privacy-filter | Presidio (`de`) |
|---|---:|---:|---:|
| langsamstes Dokument, gefenstert | **2.2 s** | 29.6 s | — |
| Regelstufe, Mittel / max | — | — | **21 ms / 305 ms** |
| Namenserkennung, Mittel / max | — | — | **17 ms / 168 ms** |
| Image | 3.34 GB | 6.39 GB | 2.5 GB |
| Spitzenspeicher (13 k Zeichen) | unkritisch | **4.8 GiB** | unkritisch |

`privacy-filter` ist auf CPU rund **13× langsamer**. Trotz 128 k Kontextfenster und
bandbegrenzter Attention wächst der Speicherbedarf mit der Sequenzlänge: ein
Durchlauf ohne Fensterung wurde vom OOM-Killer beendet (Exit 137) — die Fensterung
ist für dieses Modell keine Optimierung, sondern Betriebsvoraussetzung.

## Entscheidung

**Piiranha bleibt das ausgelieferte Modell.** Die Demo läuft auf CPU; 30 Sekunden
Wartezeit pro Dokument sind kein realistisches Produktverhalten, 2 Sekunden sind es.
Der Genauigkeitsvorsprung von `privacy-filter` rechtfertigt diesen Preis ohne GPU
nicht.

Die Wechselmöglichkeit bleibt bestehen und ist getestet: Modell und Label-Vokabular
werden gemeinsam gesetzt (`LITELLM_PII_NER_LABEL_MAP`, Build-Argument
`PII_NER_MODEL`). Mit GPU ist `privacy-filter` die bessere Wahl.

### Empfehlung mit dem grössten Verhältnis von Wirkung zu Kosten

**Die NER-Ergebnisse von Presidio in Stufe 1 zulassen.** Kein neues Modell, kein
neues Image, kein neuer Container: 43.4 % → 86.2 % Namenserkennung für zusätzliche
**17 ms** im Mittel. Das ist der einzige Hebel, der die Hauptlücke schliesst, ohne
die Demo zu verlangsamen.

Das ändert eine bewusst getroffene Architekturentscheidung (Stufe 1 liefert
ausschliesslich deterministische Muster-Entitäten, siehe
[PII_CODEC_ARCHITECTURE.md](../code/engine/PII_CODEC_ARCHITECTURE.md)) und ist
deshalb **noch nicht umgesetzt**. Der Preis sind Falschpositive: Presidio markierte
unter anderem `Fileshares`, `Finanzen` und `Link` als Person.

## Bekannte Lücken

| Lücke | Wirkung | Status |
|---|---|---|
| **AHV wird als `US_SSN` erkannt** | `US_SSN` ist auf `MASK` konfiguriert, also irreversibel. Eine Schweizer Sozialversicherungsnummer wird nach einer Regel für einen fremden Identifikator zerstört statt tokenisiert. | offen, eigene Entität nötig |
| Kunden- und Vertragsnummern | 0 % erkannt (`K-41505`, `NAT-2024-3614`). Kein Recognizer vorhanden. | offen, Regex genügt |
| Über-Maskierung | Hotline, Rechnungsadresse und Bürostandort sind öffentlich und dürfen nicht ersetzt werden; `staff.csv` enthält funktionale Logins. Ein Allowlist-Mechanismus fehlt. | **nicht gemessen** |
| Wiedererkennbarkeit | `Hans Müller`, `H. Müller` und `hmueller@…` ergeben heute drei verschiedene Tokens. Koreferenz ist ungelöst. | **nicht gemessen** |

Die letzten beiden sind bewusst als *nicht gemessen* ausgewiesen. Eine Messung, die
nur Recall kennt, erreicht 100 %, indem sie alles maskiert — der Korpus ist genau
darauf angelegt, das zu bestrafen.

## Grenzen der Messung

- **Die Sollwerte sind abgeleitet, nicht annotiert.** Sie enthalten nur Werte des
  *verknüpften* Kunden plus interne Konten. Personen anderer Kunden, die im selben
  Text vorkommen, fehlen. Der Recall-Nenner ist damit konservativ, und die Präzision
  wird systematisch zu schlecht dargestellt: von 37 zusätzlichen Presidio-Treffern
  waren die meisten echte Namen, die der abgeleiteten Referenz fehlten.
- **Präzision wird nicht ausgewiesen**, weil die Referenz dafür nicht vollständig
  genug ist. Die genannten Falschpositive sind Stichproben, keine Rate.
- **Ein Messlauf pro Konfiguration.** Die Laufzeiten sind Einzelmessungen auf einer
  Maschine unter Docker, keine Mittelwerte über Wiederholungen.
- **Nur Deutsch und Englisch.** Andere Sprachen sind im Analyzer-Image nicht
  registriert und würden die Anfrage ablehnen.

## Messungen wiederholen

```bash
cd code/engine
docker compose up -d                       # Proxy, Presidio (de), Piiranha
```

Erkennung eines einzelnen Dokuments:

```bash
curl -s -X POST http://localhost:4000/pii/detect \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"texts":["Meldende Person: Regula Zbinden, Telefon +41 76 724 51 86"],"language":"de"}'
```

Ein zweites Modell gegen dasselbe Korpus stellen:

```bash
docker build -t anonymice/pii-ner:privacy-filter \
  --build-arg PII_NER_MODEL=openai/privacy-filter \
  --build-arg TRANSFORMERS_VERSION=5.15.1 \
  --build-arg TORCH_VERSION=2.9.1 \
  docker/piiranha
docker run -d -p 8081:8080 anonymice/pii-ner:privacy-filter
```

Das Label-Vokabular muss zum Modell passen, sonst verwirft die Stufe **jede**
Vorhersage, ohne Fehler zu melden — `LITELLM_PII_NER_LABEL_MAP=privacy_filter`.
Dieser Fallstrick ist in `litellm/pii/detection/ner_labels.py` dokumentiert und
durch Tests abgesichert.

## Teststand der PII-Schicht

560 Python-Tests, davon 22 neu für Fensterung und Sprachverdrahtung sowie 9 für die
Label-Vokabulare.
