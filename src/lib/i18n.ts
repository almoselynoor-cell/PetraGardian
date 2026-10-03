export type Lang = "en" | "ar";

export const LANG_OPTIONS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
];

const en = {
  timeline: "Trip timeline",
  guardianTab: "Ride Guardian",
  guardianTag: "Your in-ride safety assistant",
  guardianIntro:
    "Ask me anything about this ride: where you are now, the nearest pharmacy, hospital or ATM, or whether this road really leads to your destination. You can type or send a voice message, and listen to my answers.",
  suggestions: ["Where am I right now?", "Where is the nearest pharmacy?", "This road feels unfamiliar. Are we still going the right way?", "How long until I arrive?"],
  askPlaceholder: "Ask anything about your current ride…",
  recording: "Recording… tap the square to send",
  thinking: "Ride Guardian is checking…",
  listen: "Listen",
  playing: "Playing…",
  voice: "Send a voice message",
  stopRecording: "Stop and send",
  send: "Send",
  micDenied: "Microphone access was blocked. Allow it in your browser to send voice messages.",
  noSpeech: "I didn't hear anything. Please try again.",
  guardianError: "Ride Guardian couldn't answer. Please try again.",
  messagesLang: "Language",
};
type Dict = typeof en;

const ar: Dict = {
  timeline: "مسار الرحلة",
  guardianTab: "حارس الرحلة",
  guardianTag: "مساعد السلامة أثناء رحلتك",
  guardianIntro:
    "اسألني أي شيء عن هذه الرحلة: أين أنت الآن، أقرب صيدلية أو مستشفى أو صراف آلي، أو هل هذا الطريق يوصلك فعلاً إلى وجهتك. يمكنك الكتابة أو إرسال رسالة صوتية والاستماع إلى إجاباتي.",
  suggestions: ["أين أنا الآن؟", "أين أقرب صيدلية؟", "الطريق يبدو غريباً، هل ما زلنا على الطريق الصحيح؟", "كم بقي حتى أصل؟"],
  askPlaceholder: "اسأل أي شيء عن رحلتك الحالية…",
  recording: "جارٍ التسجيل… اضغط المربع للإرسال",
  thinking: "حارس الرحلة يتحقق…",
  listen: "استمع",
  playing: "جارٍ التشغيل…",
  voice: "أرسل رسالة صوتية",
  stopRecording: "إيقاف وإرسال",
  send: "إرسال",
  micDenied: "تم حظر الوصول إلى الميكروفون. اسمح به في المتصفح لإرسال رسائل صوتية.",
  noSpeech: "لم أسمع شيئاً. حاول مرة أخرى.",
  guardianError: "تعذّر على حارس الرحلة الإجابة. حاول مرة أخرى.",
  messagesLang: "اللغة",
};

export function t(lang: Lang): Dict {
  return lang === "ar" ? ar : en;
}
