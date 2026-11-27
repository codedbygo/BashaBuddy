"""Rule-based assistant: intent detection + keyword matching over the demo dataset.

No LLM, no API key. Every fact in an answer comes from data/schemes.json; the code
only chooses which fields to show and wraps them in per-language templates.
"""

import json
import re
from pathlib import Path

LANGS = ("en", "hi", "te")
DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "schemes.json"
SCHEMES: list[dict] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
BY_ID = {s["id"]: s for s in SCHEMES}


def _norm(text: str) -> str:
    # Drop zero-width joiners so "స్కాలర్‌షిప్" and "స్కాలర్షిప్" compare equal.
    return re.sub(r"[​-‍]", "", text).lower().strip()


def _has(text: str, words) -> bool:
    for w in words:
        w = _norm(w)
        if w.isascii():
            if re.search(rf"\b{re.escape(w)}\b", text):
                return True
        elif w in text:  # Indic words take suffixes (రేషన్‌కార్డుకు), so substring match.
            return True
    return False


# Order matters: first match wins.
SAFETY_INTENTS = [
    ("emergency", ["suicide", "kill myself", "emergency", "accident", "heart attack", "dying", "आत्महत्या", "आपातकाल", "दुर्घटना", "ఆత్మహత్య", "అత్యవసర", "ప్రమాదం"]),
    ("unsafe_request", ["ignore previous", "ignore all", "ignore your", "system prompt", "api key", "secret key", "reveal your", "your instructions", "jailbreak", "developer mode"]),
    ("sensitive_info", ["otp", "password", "pin", "cvv", "passcode", "upi pin", "atm pin", "ओटीपी", "पासवर्ड", "पिन", "ఓటీపీ", "పాస్‌వర్డ్", "పాస్వర్డ్", "పిన్ నంబర్"]),
    ("status_or_submit", ["application status", "check my status", "track my application", "submit for me", "apply for me", "submit my application", "fill the form for me", "आवेदन की स्थिति", "मेरा आवेदन जमा", "मेरे लिए आवेदन", "దరఖాస్తు స్థితి", "నా కోసం దరఖాస్తు", "నా దరఖాస్తు సమర్పించ"]),
]
QUESTION_INTENTS = [
    ("documents", ["document", "documents", "papers", "proof", "proofs", "certificates needed", "what do i need", "what is needed", "required", "dastavez", "kagaz", "दस्तावेज", "दस्तावेज़", "कागज", "कागज़ात", "डॉक्यूमेंट", "పత్రాలు", "డాక్యుమెంట్", "డాక్యుమెంట్లు", "కాగితాలు", "ఏమి కావాలి", "ఏం కావాలి"]),
    ("eligibility", ["eligible", "eligibility", "qualify", "who can", "can i get", "am i", "patra", "पात्र", "पात्रता", "कौन ले सकता", "क्या मुझे मिलेगा", "అర్హత", "అర్హులు", "అర్హుడ", "అర్హురాల", "ఎవరు పొందవచ్చు", "నాకు వస్తుందా"]),
    ("application_steps", ["apply", "application", "how to get", "how do i get", "how can i get", "where", "process", "procedure", "steps", "register", "registration", "आवेदन", "कैसे", "कहाँ", "कहां", "अप्लाई", "प्रक्रिया", "దరఖాస్తు", "ఎలా", "ఎక్కడ", "అప్లై", "ప్రక్రియ"]),
    ("scheme_info", ["explain", "tell me", "what is", "about", "details", "समझाइए", "समझाओ", "बताइए", "बताओ", "क्या है", "వివరించండి", "చెప్పండి", "అంటే ఏమిటి", "వివరాలు"]),
]
# Words that carry no service name. If a question has nothing beyond these, it is generic
# ("How do I apply?") and we ask which service; otherwise it names a service we lack ("passport").
# ponytail: hand-made filler list; swap for a small multilingual NER model if misses pile up.
FILLER = {_w for _, ws in QUESTION_INTENTS for w in ws for _w in w.lower().split()} | set("""
i me my we a an the to for of in on is are am do does can could should would will be it this that these
there please simple simply go need needed want get government govt scheme schemes service services yojana
english telugu hindi you your which what how where who with from any some some all about
मैं मुझे मेरा हम यह वह के की का को से में है हैं हूँ क्या कैसे कहाँ कहां कौन कर करें करना सकता सकती चाहिए लिए
जाऊँ जाऊं जाना सरकारी योजना सेवा आसान हिंदी तेलुगु
నేను నాకు నా మేము ఈ ఆ కోసం కి కు లో ఏ ఏమి ఎలా ఎక్కడ ఎవరు చేయాలి చేయవచ్చు చేసుకోవాలి వెళ్ళాలి వెళ్లాలి కావాలి
ప్రభుత్వ పథకం పథకాలు సేవ సులభంగా సులభమైన తెలుగులో గురించి దీని దాని
""".split())
GREETING = ["hello", "hi", "hey", "namaste", "namaskar", "नमस्ते", "नमस्कार", "నమస్తే", "నమస్కారం", "హలో"]
LANG_SWITCH = [
    ("te", ["telugu", "తెలుగులో"]),
    ("hi", ["hindi", "हिंदी में", "हिन्दी में"]),
    ("en", ["in english"]),
]

T = {
    "disclaimer": {
        "en": "Demo information. Verify eligibility and requirements with the official government portal.",
        "hi": "डेमो जानकारी। पात्रता और ज़रूरी बातें आधिकारिक सरकारी पोर्टल पर जाँचें।",
        "te": "డెమో సమాచారం. అర్హత మరియు అవసరాలను అధికారిక ప్రభుత్వ పోర్టల్‌లో ధృవీకరించుకోండి.",
    },
    "verify_portal": {
        "en": "Please verify through the official government portal.",
        "hi": "कृपया आधिकारिक सरकारी पोर्टल पर जाँच करें।",
        "te": "దయచేసి అధికారిక ప్రభుత్వ పోర్టల్‌లో ధృవీకరించుకోండి.",
    },
    "source": {"en": "Official source: {url}", "hi": "आधिकारिक स्रोत: {url}", "te": "అధికారిక మూలం: {url}"},
    "h_docs": {"en": "Documents usually asked for {name}:", "hi": "{name} के लिए आमतौर पर माँगे जाने वाले दस्तावेज़:", "te": "{name} కోసం సాధారణంగా అడిగే పత్రాలు:"},
    "h_elig": {"en": "Who may be eligible for {name}:", "hi": "{name} के लिए कौन पात्र हो सकता है:", "te": "{name} కోసం ఎవరు అర్హులు కావచ్చు:"},
    "h_steps": {"en": "How to apply for {name}:", "hi": "{name} के लिए आवेदन कैसे करें:", "te": "{name} కోసం ఎలా దరఖాస్తు చేయాలి:"},
    "h_helps": {"en": "It may help:", "hi": "यह किनके काम आ सकता है:", "te": "ఇది ఎవరికి ఉపయోగపడవచ్చు:"},
    "elig_note": {
        "en": "I cannot confirm whether you personally qualify. The final decision is made by the government office.",
        "hi": "मैं यह पक्का नहीं कर सकता कि आप पात्र हैं या नहीं। अंतिम निर्णय सरकारी कार्यालय करता है।",
        "te": "మీరు వ్యక్తిగతంగా అర్హులా కాదా నేను నిర్ధారించలేను. తుది నిర్ణయం ప్రభుత్వ కార్యాలయం తీసుకుంటుంది.",
    },
    "steps_note": {
        "en": "BhashaBuddy cannot submit applications for you. You apply yourself at the office or portal.",
        "hi": "भाषाबडी आपके लिए आवेदन जमा नहीं कर सकता। आवेदन आपको स्वयं कार्यालय या पोर्टल पर करना होगा।",
        "te": "భాషాబడ్డీ మీ తరఫున దరఖాస్తు సమర్పించదు. మీరే కార్యాలయంలో లేదా పోర్టల్‌లో దరఖాస్తు చేయాలి.",
    },
    "fu_docs": {"en": "Would you like the list of documents?", "hi": "क्या आप दस्तावेज़ों की सूची जानना चाहेंगे?", "te": "పత్రాల జాబితా కావాలా?"},
    "fu_steps": {"en": "Would you like to know how to apply?", "hi": "क्या आप जानना चाहेंगे कि आवेदन कैसे करें?", "te": "ఎలా దరఖాస్తు చేయాలో తెలుసుకోవాలనుకుంటున్నారా?"},
    "fu_elig": {"en": "Would you like to know who may be eligible?", "hi": "क्या आप जानना चाहेंगे कि कौन पात्र हो सकता है?", "te": "ఎవరు అర్హులో తెలుసుకోవాలనుకుంటున్నారా?"},
    "q_docs": {"en": "What documents are needed for {name}?", "hi": "{name} के लिए कौन से दस्तावेज़ चाहिए?", "te": "{name} కోసం ఏ పత్రాలు కావాలి?"},
    "q_steps": {"en": "How do I apply for {name}?", "hi": "{name} के लिए आवेदन कैसे करें?", "te": "{name} కోసం ఎలా దరఖాస్తు చేయాలి?"},
    "q_elig": {"en": "Who is eligible for {name}?", "hi": "{name} के लिए कौन पात्र है?", "te": "{name} కోసం ఎవరు అర్హులు?"},
    "clarify": {
        "en": "Which service do you mean? For example: income certificate, scholarship, ration card, pension or farmer support.",
        "hi": "आप किस सेवा के बारे में पूछ रहे हैं? जैसे: आय प्रमाण पत्र, छात्रवृत्ति, राशन कार्ड, पेंशन या किसान सहायता।",
        "te": "మీరు ఏ సేవ గురించి అడుగుతున్నారు? ఉదాహరణకు: ఆదాయ ధృవీకరణ పత్రం, స్కాలర్‌షిప్, రేషన్ కార్డు, పింఛన్ లేదా రైతు సహాయం.",
    },
    "general_where": {
        "en": "Most certificates and welfare schemes are applied for at your nearest citizen service centre (MeeSeva in Telangana, village or ward secretariat in Andhra Pradesh, Common Service Centres elsewhere) or on your state's official portal.",
        "hi": "ज़्यादातर प्रमाण पत्र और कल्याण योजनाओं के लिए आवेदन नज़दीकी नागरिक सेवा केंद्र (जैसे कॉमन सर्विस सेंटर) या राज्य के आधिकारिक पोर्टल पर होता है।",
        "te": "చాలా ధృవీకరణ పత్రాలు, సంక్షేమ పథకాలకు మీ దగ్గరలోని పౌర సేవా కేంద్రంలో (తెలంగాణలో మీసేవ, ఆంధ్రప్రదేశ్‌లో గ్రామ / వార్డు సచివాలయం, ఇతర చోట్ల కామన్ సర్వీస్ సెంటర్) లేదా రాష్ట్ర అధికారిక పోర్టల్‌లో దరఖాస్తు చేయవచ్చు.",
    },
    "unknown": {
        "en": "I don't have verified information about that service yet. Please check the official government portal.",
        "hi": "मेरे पास अभी इस सेवा की सत्यापित जानकारी नहीं है। कृपया आधिकारिक सरकारी पोर्टल देखें।",
        "te": "ఈ సేవ గురించి నా దగ్గర ఇంకా ధృవీకరించిన సమాచారం లేదు. దయచేసి అధికారిక ప్రభుత్వ పోర్టల్ చూడండి.",
    },
    "greeting": {
        "en": "Namaste! I can explain government schemes, certificates and services in simple words. What would you like to know?",
        "hi": "नमस्ते! मैं सरकारी योजनाओं, प्रमाण पत्रों और सेवाओं को आसान शब्दों में समझा सकता हूँ। आप क्या जानना चाहते हैं?",
        "te": "నమస్తే! ప్రభుత్వ పథకాలు, ధృవీకరణ పత్రాలు, సేవలను సులభమైన మాటల్లో వివరిస్తాను. మీరు ఏమి తెలుసుకోవాలనుకుంటున్నారు?",
    },
    "emergency": {
        "en": "If you or someone near you is in danger, please call 112 (national emergency number) right now. For mental health support you can call Tele-MANAS at 14416. I can only help with information about government services.",
        "hi": "अगर आप या आपके पास कोई खतरे में है, तो कृपया तुरंत 112 (राष्ट्रीय आपातकालीन नंबर) पर कॉल करें। मानसिक स्वास्थ्य सहायता के लिए टेली-मानस 14416 पर कॉल करें। मैं केवल सरकारी सेवाओं की जानकारी दे सकता हूँ।",
        "te": "మీరు లేదా మీ దగ్గర ఎవరైనా ప్రమాదంలో ఉంటే, వెంటనే 112 (జాతీయ అత్యవసర నంబర్)కి కాల్ చేయండి. మానసిక ఆరోగ్య సహాయం కోసం టెలి-మానస్ 14416కి కాల్ చేయవచ్చు. నేను ప్రభుత్వ సేవల సమాచారం మాత్రమే ఇవ్వగలను.",
    },
    "sensitive_info": {
        "en": "Please never share an OTP, password, PIN or CVV with anyone, including this app. Government offices will not ask for them over chat or phone. BhashaBuddy does not need them.",
        "hi": "कृपया OTP, पासवर्ड, PIN या CVV कभी किसी से साझा न करें, इस ऐप से भी नहीं। सरकारी कार्यालय इन्हें चैट या फोन पर नहीं माँगते। भाषाबडी को इनकी ज़रूरत नहीं है।",
        "te": "దయచేసి OTP, పాస్‌వర్డ్, PIN లేదా CVV ఎవరితోనూ పంచుకోకండి, ఈ యాప్‌తో కూడా. ప్రభుత్వ కార్యాలయాలు వీటిని చాట్ లేదా ఫోన్‌లో అడగవు. భాషాబడ్డీకి ఇవి అవసరం లేదు.",
    },
    "unsafe_request": {
        "en": "I can't help with that. I can only explain government schemes and public services using demo information.",
        "hi": "मैं इसमें मदद नहीं कर सकता। मैं केवल डेमो जानकारी से सरकारी योजनाएँ और सेवाएँ समझा सकता हूँ।",
        "te": "నేను దానికి సహాయం చేయలేను. డెమో సమాచారంతో ప్రభుత్వ పథకాలు, సేవలను మాత్రమే వివరించగలను.",
    },
    "status_or_submit": {
        "en": "I cannot submit applications or check application status. I am not connected to any government database. Use the acknowledgement number from your application on the official portal or at the office where you applied. I can explain the steps if you tell me the service.",
        "hi": "मैं आवेदन जमा नहीं कर सकता और न ही उसकी स्थिति देख सकता हूँ। मैं किसी सरकारी डेटाबेस से जुड़ा नहीं हूँ। अपनी पावती संख्या से आधिकारिक पोर्टल या उसी कार्यालय में स्थिति देखें। सेवा का नाम बताएँ तो मैं चरण समझा सकता हूँ।",
        "te": "నేను దరఖాస్తులను సమర్పించలేను, వాటి స్థితిని చూడలేను. నేను ఏ ప్రభుత్వ డేటాబేస్‌కూ అనుసంధానం కాలేదు. మీ రసీదు నంబర్‌తో అధికారిక పోర్టల్‌లో లేదా దరఖాస్తు చేసిన కార్యాలయంలో స్థితి తెలుసుకోండి. సేవ పేరు చెబితే దశలు వివరిస్తాను.",
    },
}

DEFAULT_SUGGESTIONS = {
    "en": ["How do I apply for an income certificate?", "What documents are needed for a scholarship?", "How do I get a ration card?"],
    "hi": ["आय प्रमाण पत्र के लिए आवेदन कैसे करें?", "छात्रवृत्ति के लिए कौन से दस्तावेज़ चाहिए?", "राशन कार्ड कैसे बनवाएँ?"],
    "te": ["ఆదాయ ధృవీకరణ పత్రం కోసం ఎలా దరఖాస్తు చేయాలి?", "స్కాలర్‌షిప్ కోసం ఏ పత్రాలు కావాలి?", "రేషన్ కార్డు ఎలా పొందాలి?"],
}


def localize(scheme: dict, lang: str) -> dict:
    """Flatten a scheme's {en,hi,te} fields into one language for the API."""
    out = {k: (v[lang] if isinstance(v, dict) and lang in v else v) for k, v in scheme.items() if k != "keywords"}
    return out


def find_scheme(text: str) -> dict | None:
    best, best_score = None, 0
    for s in SCHEMES:
        score = sum(len(k) for k in s["keywords"] if _has(text, [k]))
        if score > best_score:
            best, best_score = s, score
    return best


def _bullets(items: list[str]) -> str:
    return "\n".join(f"• {i}" for i in items)


def _source_line(s: dict, lang: str) -> str:
    url = s.get("official_source")
    return T["source"][lang].format(url=url) if url else T["verify_portal"][lang]


def _scheme_suggestions(s: dict, lang: str, skip: str) -> list[str]:
    name = s["name"][lang]
    keys = {"documents": "q_docs", "application_steps": "q_steps", "eligibility": "q_elig"}
    return [T[k][lang].format(name=name) for intent, k in keys.items() if intent != skip]


def respond(message: str, lang: str = "en", last_scheme_id: str | None = None) -> dict:
    text = _norm(message)
    for code, words in LANG_SWITCH:
        if _has(text, words):
            lang = code
            break
    if lang not in LANGS:
        lang = "en"

    base = {"language": lang, "scheme": None, "verification_status": None, "follow_up": None,
            "suggestions": [], "disclaimer": T["disclaimer"][lang]}

    for intent, words in SAFETY_INTENTS:
        if _has(text, words):
            return base | {"intent": intent, "answer": T[intent][lang], "suggestions": DEFAULT_SUGGESTIONS[lang]}

    intent = next((name for name, words in QUESTION_INTENTS if _has(text, words)), None)
    scheme = find_scheme(text)
    if scheme is None and intent and last_scheme_id in BY_ID:
        scheme = BY_ID[last_scheme_id]  # follow-up like "What documents do I need?"

    if scheme is None:
        words = {w.strip("?.!,।:;\"'") for w in text.split()} - {""}
        names_something = bool(words - FILLER - {_norm(g) for g in GREETING})
        if intent is None and _has(text, GREETING) and not names_something:
            return base | {"intent": "greeting", "answer": T["greeting"][lang], "suggestions": DEFAULT_SUGGESTIONS[lang]}
        if names_something:
            return base | {"intent": "unknown", "answer": T["unknown"][lang], "suggestions": DEFAULT_SUGGESTIONS[lang]}
        if intent == "application_steps":
            return base | {"intent": "general_guidance", "answer": T["general_where"][lang],
                           "follow_up": T["clarify"][lang], "suggestions": DEFAULT_SUGGESTIONS[lang]}
        return base | {"intent": "clarify", "answer": T["clarify"][lang], "follow_up": T["clarify"][lang],
                       "suggestions": DEFAULT_SUGGESTIONS[lang]}

    name = scheme["name"][lang]
    if intent == "documents":
        body = f"{T['h_docs'][lang].format(name=name)}\n{_bullets(scheme['required_documents'][lang])}"
        follow = T["fu_steps"][lang]
    elif intent == "eligibility":
        body = f"{T['h_elig'][lang].format(name=name)}\n{_bullets(scheme['eligibility'][lang])}\n\n{T['elig_note'][lang]}"
        follow = T["fu_docs"][lang]
    elif intent == "application_steps":
        steps = "\n".join(f"{i}. {s}" for i, s in enumerate(scheme["application_steps"][lang], 1))
        body = f"{T['h_steps'][lang].format(name=name)}\n{steps}\n\n{T['steps_note'][lang]}"
        follow = T["fu_docs"][lang]
    else:
        intent = "certificate_info" if scheme["category"] == "certificate" else "scheme_info"
        body = f"{name}\n{scheme['description'][lang]}\n\n{T['h_helps'][lang]}\n{_bullets(scheme['who_it_may_help'][lang])}"
        follow = T["fu_elig"][lang]

    summary = {k: scheme[k] for k in ("id", "category", "official_source", "verification_status", "last_verified")}
    return base | {
        "intent": intent,
        "answer": f"{body}\n\n{_source_line(scheme, lang)}",
        "scheme": summary | {"name": name},
        "verification_status": scheme["verification_status"],
        "follow_up": follow,
        "suggestions": _scheme_suggestions(scheme, lang, intent),
    }
