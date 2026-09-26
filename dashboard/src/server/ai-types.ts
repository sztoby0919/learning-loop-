export interface LearningRecord {
  date: string;
  content: string;
  mastery: number | null;
  difficulty: string;
  nextStep: string;
}

export interface AssessmentQuestion {
  id: string;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  knowledgePoint: string;
}

export interface PublicAssessmentQuestion {
  id: string;
  question: string;
  options: string[];
  knowledgePoint: string;
}

export interface AnswerFeedback {
  questionId: string;
  isCorrect: boolean;
  score: number;
  correctPart: string;
  gap: string;
  evidence: string;
  feynmanExplanation?: string;
}

export interface DiagnosisResult {
  courseId: string;
  weakPoints: Array<{
    knowledgePoint: string;
    evidence: string;
    severity: "high" | "medium" | "low";
  }>;
  remediationTasks: string[];
  nextReviewDate: string;
  proposedChanges: {
    courseMarkdown: string;
    reviewsMarkdown: string;
    mistakesMarkdown: string;
    sessionMarkdown: string;
  };
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface AiRunRecord {
  id: string;
  timestamp: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  inputSource: string;
  success: boolean;
  error?: string;
}
