import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountsRouter from "./accounts";
import botsRouter from "./bots";
import sessionsRouter from "./sessions";
import rulesRouter from "./rules";
import aiRouter from "./ai";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountsRouter);
router.use(botsRouter);
router.use(sessionsRouter);
router.use(rulesRouter);
router.use(aiRouter);
router.use(statsRouter);

export default router;
