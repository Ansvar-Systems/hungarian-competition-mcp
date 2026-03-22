import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["GVH_DB_PATH"] ?? "data/gvh.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log("Deleted " + DB_PATH); }

const db = new Database(DB_PATH);
db.exec(SCHEMA_SQL);

const decisions = [
  { case_number: "GVH-VJ/001/2024", title: "Epuletanyag-forgalmazok karteljanak vizsgalata", date: "2024-03-20", type: "cartel", sector: "retail", parties: "Epitoanyag Alfa Kft.; Material Beta Zrt.; Forgalmazas Gamma Kft.", summary: "GVH birsagot szabott ki harom epuletanyag-forgalmazora kartellmegallapodas miatt.", full_text: "GVH VJ/001/2024\n\nHarom epuletanyag-forgalmazo kartellmegallapodast kotott a Tpvt. 11. paragrafusa es EUMSZ 101. cikke megsertesevel. Koordinaltak az arakat es felosztottak a foldrajzi piacokat 3 even at.\n\nBirsag: 850.000.000 Ft.", outcome: "fine", fine_amount: 850000000, competition_articles: "Tpvt. 11. §, EUMSZ 101. cikk", status: "final" },
  { case_number: "GVH-VJ/002/2024", title: "Erofölénnyel való visszaeles a foldgaz-elosztas piacan", date: "2024-05-28", type: "abuse_of_dominance", sector: "energy", parties: "Gazelosztó Zrt.", summary: "GVH birsagot szabott ki a dominas foldgaz-eloszto szamara diszkriminativ feltetelek alkalmazasa miatt.", full_text: "GVH VJ/002/2024\n\nDominans gazelosztó eltero muszaki es kereskedelmi feltételeket alkalmazott a független szolgáltatókkal szemben, kiszoritva a versenytarsakat.\n\nBirsag: 1.200.000.000 Ft es atalatos hozzaferesi feltetelek kotelezettsege.", outcome: "fine", fine_amount: 1200000000, competition_articles: "Tpvt. 21. §, EUMSZ 102. cikk", status: "final" },
  { case_number: "GVH-VJ/003/2024", title: "Mobiltelekommunikacis piac szektorelemzese", date: "2024-07-15", type: "sector_inquiry", sector: "telecommunications", parties: "Magyarorszagi mobilszolgaltatok", summary: "GVH szektorelemzest inditott a mobiltelekommunikacios piacon, kulonos tekintettel a nagykereskedelmi arakra.", full_text: "GVH szektorelemzes VJ/003/2024\n\nVizsgalati teruletek: nagykereskedelmi hozzaferes arai, MVNO feltetelei, roaming megallapodasok, csomagdijak.\n\nEredmeny: 18 honapon belul.", outcome: "ongoing", fine_amount: null, competition_articles: "Tpvt. 43/H. §", status: "ongoing" },
  { case_number: "GVH-VJ/004/2024", title: "Gyogyszerek ertekesitesi felteteleinek osszehangoalasa", date: "2024-09-10", type: "cartel", sector: "pharmaceuticals", parties: "Gyogyszer-nagykereskedő Kft.; Gyogyszertarlanc Zrt.", summary: "Tiltott megallapodas OTC gyogyszerek minimalis kiskereskedelmi ararol.", full_text: "GVH VJ/004/2024\n\nRPM OTC gyogyszerekre korlatatozta a kiskereskedelmi arversenyt.\n\nBirsag: 320.000.000 Ft.", outcome: "fine", fine_amount: 320000000, competition_articles: "Tpvt. 11. §", status: "final" },
  { case_number: "GVH-VJ/005/2024", title: "Online kiskereskedelem tisztességtelen feltetelei", date: "2024-11-25", type: "abuse_of_dominance", sector: "retail", parties: "Online Piacter HU Zrt.", summary: "GVH kotelezettségvallalasokat fogadott el dominas online piacterektol tisztesegtelen szerzodesi feltetelekrol.", full_text: "GVH VJ/005/2024\n\nDominas online piacter egyoldaluan modosithato feltételeket, aranytalanul magas dijakat és exkluzivitasi kotelezettsegeket alkalmazott.\n\nKötelezettségvállalások: atlatható feltételek, retroaktiv dijak tilalma, független vitarendezési mechanizmus.", outcome: "remedies", fine_amount: null, competition_articles: "Tpvt. 21. §", status: "final" },
];

const mergers = [
  { case_number: "GVH-M001/2024", title: "Koncentracio az elelmiszer-kiskereskedelemben", date: "2024-04-25", sector: "retail", acquiring_party: "Szupermarket Alfa Zrt.", target: "Kiskereskedelmi Beta Kft.", summary: "Engedélyezve feltételekkel - uzletek elidegenítese harom regioban ahol fuzia erofölényes helyzetet teremtene.", full_text: "GVH M001/2024\n\nFuzio utan 40%-os paci reszesedes harom regioban.\n\nFeltetelék: 15 uzlet elidegenítese Pest, Borsod-Abauj-Zemplen es Szabolcs-Szatmar-Bereg megyeben.", outcome: "approved_with_conditions", turnover: null },
  { case_number: "GVH-M002/2024", title: "Regionalis tavkozlesi szolgaltato felvasarlasa", date: "2024-07-05", sector: "telecommunications", acquiring_party: "Telekom HU Zrt.", target: "RegioNet Kft.", summary: "Feltetel nelkul engedelyezve - alacsony paci reszesedes a megszerezett tarsasagnal.", full_text: "GVH M002/2024\n\nRegioNet 5% alatti paci reszesedéssel rendelkezik. Horizontalis atfedesek minimalisak.\n\nOsszefonoadas engedélyezve, feltetelék nélkül.", outcome: "approved", turnover: null },
  { case_number: "GVH-M003/2024", title: "Bankszektorbeli osszelvadas", date: "2024-10-15", sector: "banking", acquiring_party: "Gamma Bank Zrt.", target: "Delta Penzugyi Intezet Zrt.", summary: "Melyebb vizsgalat ket kozepes méretu bank osszeolvadasahoz retail es kkv-hitelek piacara vonatkozoan.", full_text: "GVH II. fazis M003/2024\n\nKombinalt paci reszesedes haladja meg a 25%-ot retail jelzalogban. Koordinacios hatasok aggalya kkv-hiteleknél.\n\nVart dontes: II. fazistol 90 munkanapon belul.", outcome: "under_review", turnover: null },
];

const iD = db.prepare("INSERT OR REPLACE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, competition_articles, status) VALUES (@case_number, @title, @date, @type, @sector, @parties, @summary, @full_text, @outcome, @fine_amount, @competition_articles, @status)");
const iM = db.prepare("INSERT OR REPLACE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (@case_number, @title, @date, @sector, @acquiring_party, @target, @summary, @full_text, @outcome, @turnover)");

for (const d of decisions) iD.run(d);
for (const m of mergers) iM.run(m);

console.log("Seeded " + decisions.length + " decisions, " + mergers.length + " mergers into " + DB_PATH);
db.close();
