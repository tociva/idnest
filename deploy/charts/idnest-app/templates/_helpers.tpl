{{- define "idnest-app.name" -}}
{{- default .Chart.Name .Values.component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "idnest-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "idnest-%s" (required "component is required" .Values.component) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "idnest-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "idnest-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "idnest-app.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{ include "idnest-app.selectorLabels" . }}
app.kubernetes.io/component: {{ required "component is required" .Values.component }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "idnest-app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "idnest-app.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when creation is disabled" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "idnest-app.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $digest := required "image.digest is required" .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "image.digest must be a sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}

{{- define "idnest-app.fixedEnv" -}}
- name: NODE_ENV
  value: production
- name: HOST
  value: 0.0.0.0
- name: INTERNAL_HEALTH_SERVER_ENABLED
  value: "true"
- name: INTERNAL_HEALTH_PORT
  value: {{ .Values.probes.port | quote }}
- name: APP_REVISION
  value: {{ .Values.revision | quote }}
{{- if eq .Values.component "auth" }}
- name: AUTH_BACKEND_PORT
  value: {{ .Values.service.targetPort | quote }}
{{- else if eq .Values.component "admin" }}
- name: ADMIN_BACKEND_PORT
  value: {{ .Values.service.targetPort | quote }}
{{- else }}
{{- fail "component must be auth or admin" }}
{{- end }}
{{- end -}}

