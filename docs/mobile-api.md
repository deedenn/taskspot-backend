# Mobile API v1

Префикс: `/api/mobile/v1`. Текущий web API остаётся совместимым.

## Сессии

`POST /auth/login` принимает `email`, `password`, `installationId`, `platform`. Access JWT действует 15 минут; refresh token — 30 дней и ротируется при каждом `POST /auth/refresh`. Повторное использование старого refresh token отклоняется. `POST /auth/logout` отзывает текущую device session.

## Чтение

- `GET /bootstrap` — пользователь, активные проекты и счётчики;
- `GET /feed?scope=all&focus=active&limit=30&cursor=...` — стабильная cursor pagination по `updatedAt + _id`;
- `GET /tasks/:taskId` — полная задача с `version`;
- `GET /control/summary` и `/control/assignees` — оперативный контроль;
- `GET /notifications` — cursor-based входящие.

Права совпадают с web: администратор проекта видит все задачи, участник — только задачи, где он инициатор, ответственный или наблюдатель.

## Offline-safe mutations

`POST /tasks`, `PATCH /tasks/:taskId/status`, `PATCH /tasks/:taskId/checklist/:itemId` и `POST /tasks/:taskId/comments` требуют уникальный `Idempotency-Key`. Изменения существующего состояния дополнительно требуют `If-Match: "<version>"`. При устаревшей версии API возвращает `409`; клиент должен обновить задачу и не применять last-write-wins.

## Push

`PUT /devices/:installationId` регистрирует Expo push token, `DELETE` отключает его. Новые `Notification` создают `PushJob`; worker отправляет jobs отдельно от HTTP-запроса, проверяет Expo receipts и отключает `DeviceNotRegistered` tokens. Для временного отключения отправки задайте `EXPO_PUSH_ENABLED=false`.
