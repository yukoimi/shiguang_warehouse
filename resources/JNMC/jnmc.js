// 济宁医学院教务（乘方教务 · 旧版 .action 接口）适配器
// 流程：提示已登录 → 选择学期 → 拉取整学期课表 → 按需用日历接口补齐作息时间 → 保存课程与作息
// 接口：
//   GET  /xsgrkbcx!getXsgrbkList.action          课表主页（内含学期下拉 xnxqdm）
//   GET  /xsgrkbcx!xsAllKbList.action?xnxqdm=XX  整学期课表（HTML 内嵌 var kbxx=[...] 课程 JSON）
//   POST /default!getCalendar.action             桌面日历事件（每节课带精确起止时间，用于补齐作息）

// 预置作息表（节 1~12 连续，App 要求时间槽从 1 开始且连续；学校作息共 12 节，网格 14 行是模板冗余）
// 依据：《济宁医学院节次表》（2019 官方文档，40 分钟/节 + 10 分钟课间，分冬季/夏季两套）
// 节 1~4、6~9：官方表与 2026 年学生课表 64 个日历事件实测互相印证（节 8/9 实测比官方夏季表后移 10 分钟，以实测为准）
// 节 5：官方表 11:30-12:10（午前第五节）
// 节 10~12：官方夏季表晚间段（系统事件按统一时间生成，不随冬季作息切换）
// 备注：冬季作息下午 14:00 起、晚间 19:00 起，与系统排课时间不同，以系统实测时间为准
// 若实际课表含节 10~12 的课，getCalendar 的单节事件会精确覆盖对应预置值
const PRESET_TIME_SLOTS = [
    { number: 1, startTime: "08:00", endTime: "08:40" },
    { number: 2, startTime: "08:50", endTime: "09:30" },
    { number: 3, startTime: "09:50", endTime: "10:30" },
    { number: 4, startTime: "10:40", endTime: "11:20" },
    { number: 5, startTime: "11:30", endTime: "12:10" },
    { number: 6, startTime: "14:30", endTime: "15:10" },
    { number: 7, startTime: "15:20", endTime: "16:00" },
    { number: 8, startTime: "16:20", endTime: "17:00" },
    { number: 9, startTime: "17:10", endTime: "17:50" },
    { number: 10, startTime: "18:00", endTime: "18:40" },
    { number: 11, startTime: "19:30", endTime: "20:10" },
    { number: 12, startTime: "20:20", endTime: "21:00" }
];

// 周次字符串（"10,7,8,9"）→ 去重排序的周数组
function parseWeeks(weekStr) {
    if (!weekStr) return [];
    const weeks = weekStr.split(",").map(w => parseInt(w.trim(), 10)).filter(w => !isNaN(w) && w > 0);
    return [...new Set(weeks)].sort((a, b) => a - b);
}

function cleanTeacherName(raw) {
    return String(raw || "").replace(/\[[^\]]*\]/g, "").trim();
}

// 教室可能为空、含 "\\" 分隔的多个教室（如 "B205\206教室"）或以 "," 分隔的多场地
function resolvePosition(raw) {
    const position = String(raw || "").replace(/\\/g, "/").trim();
    return position || "待定";
}

function minutesToHHMM(totalMin) {
    const h = Math.floor(totalMin / 60);
    const m = Math.round(totalMin % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 课表 JSON 解析：kbxx 字段 → 拾光课程格式
function parseCourseList(kbxx) {
    if (!Array.isArray(kbxx)) throw new Error("课表接口返回格式不正确");
    const courseMap = new Map();
    kbxx.forEach(item => {
        const day = parseInt(item.xq, 10);
        const sections = String(item.jcdm2 || "").split(",")
            .map(s => parseInt(s.trim(), 10)).filter(s => !isNaN(s));
        const allWeeks = parseWeeks(item.zcs);
        if (!item.kcmc || sections.length === 0 || allWeeks.length === 0 || isNaN(day) || day < 1 || day > 7) return;

        const course = {
            name: item.kcmc.trim(),
            teacher: cleanTeacherName(item.teaxms) || "未知",
            position: resolvePosition(item.jxcdmcs),
            day,
            startSection: Math.min(...sections),
            endSection: Math.max(...sections),
            weeks: allWeeks
        };

        const key = [course.name, course.teacher, course.position, course.day,
            course.startSection, course.endSection].join("__");
        const existing = courseMap.get(key);
        if (existing) existing.weeks = [...new Set([...existing.weeks, ...course.weeks])].sort((a, b) => a - b);
        else courseMap.set(key, course);
    });
    return Array.from(courseMap.values()).sort((a, b) =>
        a.day - b.day || a.startSection - b.startSection || a.endSection - b.endSection || a.name.localeCompare(b.name)
    );
}

// 把日历事件（lx=kb，带 qssj/jssj/ps/pe）合并进作息表：
// 单节事件（ps==pe）的起止时间即该节精确作息，直接覆盖预置值；
// 多节事件只填充预置中缺失的节次（多节段按等时长切分）
function mergeTimeSlots(events) {
    const slots = new Map(PRESET_TIME_SLOTS.map(s => [s.number, { ...s }]));
    (Array.isArray(events) ? events : []).forEach(event => {
        if (String(event.lx || "").trim() !== "kb") return;
        const ps = parseInt(event.ps, 10);
        const pe = parseInt(event.pe, 10);
        const start = String(event.qssj || "").slice(0, 5);
        const end = String(event.jssj || "").slice(0, 5);
        if (isNaN(ps) || isNaN(pe) || ps < 1 || pe < ps) return;
        if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return;

        if (ps === pe) {
            slots.set(ps, { number: ps, startTime: start, endTime: end });
            return;
        }
        const [sh, sm] = start.split(":").map(Number);
        const [eh, em] = end.split(":").map(Number);
        const totalMin = (eh * 60 + em) - (sh * 60 + sm);
        const count = pe - ps + 1;
        if (totalMin <= 0 || count < 2) return;
        const segment = totalMin / count;
        for (let s = ps; s <= pe; s++) {
            if (slots.has(s)) continue;
            const offset = (s - ps) * segment;
            slots.set(s, {
                number: s,
                startTime: minutesToHHMM(sh * 60 + sm + offset),
                endTime: minutesToHHMM(sh * 60 + sm + offset + segment)
            });
        }
    });
    return Array.from(slots.values()).sort((a, b) => a.number - b.number);
}

// 读取页面中的学期下拉框
function extractSemesterOptions(doc) {
    const selectElem = doc.getElementById("xnxqdm");
    if (!selectElem) return null;
    const semesters = [];
    const semesterValues = [];
    let defaultIndex = 0;
    Array.from(selectElem.querySelectorAll("option")).forEach(option => {
        if (!option.value) return;
        semesters.push(option.innerText.trim());
        semesterValues.push(option.value);
        if (option.selected || option.hasAttribute("selected")) defaultIndex = semesters.length - 1;
    });
    if (semesters.length === 0) return null;

    const start = Math.max(0, defaultIndex - 1);
    const end = Math.min(semesters.length, defaultIndex + 10);
    return {
        semesters: semesters.slice(start, end),
        semesterValues: semesterValues.slice(start, end),
        defaultIndex: defaultIndex - start
    };
}

// 导入前提示用户先登录教务系统
async function promptUserToStart() {
    return await window.shiguangBridgePromise.showAlert(
        "济宁医学院教务导入",
        "请先确保已登录教务系统，再继续导入。",
        "我已登录"
    );
}

// 从页面已有学期中选择目标学期
async function selectSemester(semesterOptions) {
    const selectedIndex = await window.shiguangBridgePromise.showSingleSelection(
        "选择学期",
        JSON.stringify(semesterOptions.semesters),
        semesterOptions.defaultIndex
    );
    if (selectedIndex === null || selectedIndex < 0) return null;
    return {
        label: semesterOptions.semesters[selectedIndex],
        value: semesterOptions.semesterValues[selectedIndex]
    };
}

// 获取课表页 HTML（含学期列表）
async function fetchSchedulePage() {
    const response = await fetch("/xsgrkbcx!getXsgrbkList.action", { method: "GET", credentials: "include" });
    if (!response.ok) throw new Error(`无法打开课表页面（HTTP ${response.status}）`);
    return response.text();
}

// 获取指定学期的整学期课表 HTML（内嵌 var kbxx=[...]）
async function fetchCourseData(xnxqdm) {
    const response = await fetch(
        `/xsgrkbcx!xsAllKbList.action?xnxqdm=${encodeURIComponent(xnxqdm)}`,
        { method: "GET", credentials: "include" }
    );
    if (!response.ok) throw new Error(`课表请求失败（HTTP ${response.status}）`);
    const htmlText = await response.text();
    const match = htmlText.match(/var\s+kbxx\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) throw new Error("课表数据解析失败，请检查登录状态");
    let kbxx;
    try {
        kbxx = JSON.parse(match[1]);
    } catch (error) {
        throw new Error(`课表数据解析失败：${error.message}`);
    }
    return kbxx;
}

// 拉取日历事件（含每节课的精确起止时间），用于补齐作息表中缺失的节次
async function fetchCalendarEvents(xnxqdm) {
    const year = parseInt(String(xnxqdm).slice(0, 4), 10);
    const term = String(xnxqdm).slice(4, 6);
    const [d1, d2] = term === "02"
        ? [`${year}-01-01 00:00:00`, `${year}-08-31 23:59:59`]
        : [`${year}-08-01 00:00:00`, `${year + 1}-08-31 23:59:59`];
    const formData = new URLSearchParams();
    formData.append("d1", d1);
    formData.append("d2", d2);
    const response = await fetch("/default!getCalendar.action", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body: formData.toString()
    });
    if (!response.ok) throw new Error(`日历请求失败（HTTP ${response.status}）`);
    return response.json();
}

async function saveCourses(courses) {
    await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses));
}

async function saveTimeSlots(timeSlots) {
    if (timeSlots.length === 0) return;
    await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(timeSlots));
}

// 编排导入流程：提示 → 选学期 → 请求课表 → 补齐作息 → 保存
async function runImportFlow() {
    try {
        const confirmed = await promptUserToStart();
        if (!confirmed) { window.shiguangBridge.showToast("导入已取消"); return; }

        const pageHtml = await fetchSchedulePage();
        const semesterOptions = extractSemesterOptions(new DOMParser().parseFromString(pageHtml, "text/html"));
        if (!semesterOptions) throw new Error("未找到学期列表，请先登录教务系统");

        const semester = await selectSemester(semesterOptions);
        if (!semester) { window.shiguangBridge.showToast("导入已取消"); return; }

        window.shiguangBridge.showToast(`正在获取 ${semester.label} 的课表...`);
        const courses = parseCourseList(await fetchCourseData(semester.value));

        if (courses.length === 0) {
            await window.shiguangBridgePromise.showAlert(
                "提示",
                "该学期没有获取到课程数据，请检查登录状态和所选学期。",
                "确定"
            );
            return;
        }

        let timeSlots = PRESET_TIME_SLOTS.map(s => ({ ...s }));
        try {
            timeSlots = mergeTimeSlots(await fetchCalendarEvents(semester.value));
        } catch (error) {
            // 日历接口失败不影响主流程，仅使用预置作息表
            window.shiguangBridge.showToast("作息时间使用预置数据（日历接口不可用）");
        }

        await saveCourses(courses);
        try {
            await saveTimeSlots(timeSlots);
        } catch (error) {
            window.shiguangBridge.showToast(`课程已导入，作息时间导入失败：${error.message}`);
        }

        window.shiguangBridge.showToast("导入完成");
        window.shiguangBridge.notifyTaskCompletion();
    } catch (error) {
        await window.shiguangBridgePromise.showAlert(
            "导入失败",
            error.message || String(error),
            "确定"
        );
    }
}

runImportFlow();
