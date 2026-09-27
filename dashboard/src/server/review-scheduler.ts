import type { CourseDetail, ReviewItem, ReviewStatus, ScheduledReview } from "../shared/course.js";
export type { ScheduledReview } from "../shared/course.js";

const REVIEW_INTERVALS_DAYS = [1, 3, 7, 30];

export function scheduleReviewTimelineForCourse(course: CourseDetail, today: string = new Date().toISOString().slice(0, 10), explicitTopics: ReadonlySet<string> = new Set()): ScheduledReview[] {
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  return course.records.flatMap((record) => {
    if (explicitTopics.has(record.content.slice(0, 60) || "学习记录")) return [];
    const recordTime = Date.parse(`${record.date}T00:00:00Z`);
    if (!Number.isFinite(recordTime)) return [];
    return REVIEW_INTERVALS_DAYS.map((interval, reviewNumber) => {
      const nextReviewTime = recordTime + interval * 86_400_000;
      return {
        courseId: course.id,
        courseTitle: course.title,
        accent: course.accent,
        topic: record.content.slice(0, 60) || "学习记录",
        stage: "全课程",
        recordDate: record.date,
        reviewNumber,
        nextReviewDate: new Date(nextReviewTime).toISOString().slice(0, 10),
        daysUntilReview: Math.round((nextReviewTime - todayTime) / 86_400_000),
        mastery: record.mastery,
      };
    });
  });
}

export function scheduleReviewsForCourse(course: CourseDetail, today: string = new Date().toISOString().slice(0, 10), explicitTopics: ReadonlySet<string> = new Set()): ScheduledReview[] {
  const timeline = scheduleReviewTimelineForCourse(course, today, explicitTopics);
  return course.records.flatMap((record) => {
    const planned = timeline.filter((review) => review.recordDate === record.date && review.topic === (record.content.slice(0, 60) || "学习记录"));
    return planned[0] ?? [];
  });
}

export function getStatus(daysUntilReview: number): ReviewStatus {
  if (daysUntilReview < 0) return "overdue";
  if (daysUntilReview === 0) return "today";
  if (daysUntilReview <= 2) return "upcoming";
  return "unscheduled";
}

export function getDueReviews(allCourses: CourseDetail[], limit = 20, today: string = new Date().toISOString().slice(0, 10), explicitReviews: ReviewItem[] = []): ScheduledReview[] {
  const allReviews: ScheduledReview[] = [];
  for (const course of allCourses) {
    const explicitForCourse = explicitReviews.filter((review) => review.courseId === course.id);
    const explicitTopics = new Set(explicitForCourse.map((review) => review.topic));
    allReviews.push(...scheduleReviewsForCourse(course, today, explicitTopics));
    for (const review of explicitForCourse) {
      if (!review.nextReview) continue;
      const daysUntilReview = Math.round((Date.parse(`${review.nextReview}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      allReviews.push({ courseId: course.id, courseTitle: course.title, accent: course.accent, topic: review.topic, stage: "复习计划", recordDate: review.lastReviewed ?? review.nextReview, reviewNumber: 0, nextReviewDate: review.nextReview, daysUntilReview, mastery: review.mastery });
    }
  }

  // Sort by urgency: overdue first, then by days until review
  return allReviews
    .filter((r) => r.daysUntilReview <= 7)
    .sort((a, b) => a.daysUntilReview - b.daysUntilReview)
    .slice(0, limit);
}
