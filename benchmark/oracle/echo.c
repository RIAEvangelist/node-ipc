#define _POSIX_C_SOURCE 200112L

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>
typedef SOCKET socket_t;
#define CLOSESOCKET closesocket
#define GETPID _getpid
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
#define CLOSESOCKET close
#define GETPID getpid
#define INVALID_SOCKET -1
#define SOCKET_ERROR -1
#endif

static double process_cpu_seconds(void) {
#ifdef _WIN32
    FILETIME created, exited, kernel, user;
    ULARGE_INTEGER kernel_time, user_time;
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return -1.0;
    kernel_time.LowPart = kernel.dwLowDateTime;
    kernel_time.HighPart = kernel.dwHighDateTime;
    user_time.LowPart = user.dwLowDateTime;
    user_time.HighPart = user.dwHighDateTime;
    return (double)(kernel_time.QuadPart + user_time.QuadPart) / 10000000.0;
#else
    return (double)clock() / CLOCKS_PER_SEC;
#endif
}

static int send_all(socket_t socket, const char *buffer, int length) {
    int sent = 0;
    while (sent < length) {
        int count = send(socket, buffer + sent, length - sent, 0);
        if (count == SOCKET_ERROR) {
#ifndef _WIN32
            if (errno == EINTR) continue;
#endif
            return 0;
        }
        sent += count;
    }
    return 1;
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    const char *port = "0";
    struct addrinfo hints;
    struct addrinfo *addresses = NULL;
    socket_t listener = INVALID_SOCKET;
    socket_t client = INVALID_SOCKET;
    uint64_t bytes_in = 0;
    uint64_t bytes_out = 0;
    char buffer[65536];
    double cpu_start = process_cpu_seconds();

    for (int i = 1; i < argc - 1; i += 2) {
        if (strcmp(argv[i], "--host") == 0) host = argv[i + 1];
        else if (strcmp(argv[i], "--port") == 0) port = argv[i + 1];
        else return 2;
    }
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 1;
#endif
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    if (getaddrinfo(host, port, &hints, &addresses) != 0) return 1;

    listener = socket(addresses->ai_family, addresses->ai_socktype, addresses->ai_protocol);
    if (listener == INVALID_SOCKET) return 1;
    if (bind(listener, addresses->ai_addr, (int)addresses->ai_addrlen) == SOCKET_ERROR) return 1;
    freeaddrinfo(addresses);
    if (listen(listener, 1) == SOCKET_ERROR) return 1;

    struct sockaddr_in bound;
#ifdef _WIN32
    int bound_size = sizeof(bound);
#else
    socklen_t bound_size = sizeof(bound);
#endif
    if (getsockname(listener, (struct sockaddr *)&bound, &bound_size) == SOCKET_ERROR) return 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("{\"type\":\"ready\",\"pid\":%d,\"host\":\"%s\",\"port\":%u}\n",
        (int)GETPID(), host, (unsigned)ntohs(bound.sin_port));

    client = accept(listener, NULL, NULL);
    if (client == INVALID_SOCKET) return 1;
    {
        int enabled = 1;
        setsockopt(client, IPPROTO_TCP, TCP_NODELAY, (const char *)&enabled, sizeof(enabled));
    }
    for (;;) {
        int count = recv(client, buffer, sizeof(buffer), 0);
        if (count == 0) break;
        if (count == SOCKET_ERROR) {
#ifndef _WIN32
            if (errno == EINTR) continue;
#endif
            return 1;
        }
        if (!send_all(client, buffer, count)) return 1;
        bytes_in += (uint64_t)count;
        bytes_out += (uint64_t)count;
    }
    CLOSESOCKET(client);
    CLOSESOCKET(listener);
#ifdef _WIN32
    WSACleanup();
#endif
    double cpu_end = process_cpu_seconds();
    double cpu_seconds = cpu_start >= 0.0 && cpu_end >= 0.0 ? cpu_end - cpu_start : -1.0;
    printf("{\"type\":\"cleanup\",\"acceptedConnections\":1,\"activeSocketsAfterClose\":0,"
        "\"bytesIn\":%llu,\"bytesOut\":%llu,\"destroyedSockets\":0,\"cpuSeconds\":%.9f}\n",
        (unsigned long long)bytes_in, (unsigned long long)bytes_out,
        cpu_seconds);
    return 0;
}
